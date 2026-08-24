import {
  UA,
  collectLinks,
  extract,
  isProtected,
  isFileHostUrl,
  type PixeldrainItem,
  type ScrapeResult,
} from "./pixeldrain-extract";

async function fetchPage(url: string) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
  });
  const type = res.headers.get("content-type") ?? "";
  const html =
    type.includes("html") || type.includes("text") || type === "" ? await res.text() : "";
  return { ok: res.ok, status: res.status, finalUrl: res.url || url, html };
}

/**
 * Ask Pixeldrain for the real filename of each file/list so wget can save it
 * under the right name instead of the API path.
 */
async function namePixeldrainItems(found: Map<string, PixeldrainItem>) {
  await Promise.all(
    [...found.values()]
      .filter((i) => i.host === "pixeldrain" && !i.filename)
      .map(async (item) => {
        const url =
          item.kind === "file"
            ? `https://pixeldrain.com/api/file/${item.id}/info`
            : `https://pixeldrain.com/api/list/${item.id}`;
        try {
          const res = await fetch(url, {
            headers: { "User-Agent": UA, Accept: "application/json" },
          });
          if (!res.ok) return;
          const json = (await res.json()) as { name?: string; title?: string };
          const name = (json.name ?? json.title ?? "").trim();
          if (!name) return;
          item.filename =
            item.kind === "list"
              ? `${name.replace(/[/\\]/g, "_")}.zip`
              : name.replace(/[/\\]/g, "_");
        } catch {
          /* keep the default filename behaviour */
        }
      }),
  );
}

function fileDitchPowFields(html: string) {
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input\b[^>]*\bname=["']([^"']+)["'][^>]*\bvalue=["']([^"']*)["'][^>]*>/gi)) {
    const name = match[1];
    if (name) fields[name] = match[2] ?? "";
  }
  return fields;
}

function leadingZeroBits(bytes: Uint8Array, count: number) {
  const fullBytes = Math.floor(count / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  const remaining = count % 8;
  return remaining === 0 || ((bytes[fullBytes] ?? 255) >> (8 - remaining)) === 0;
}

/** Hard limits so the hosted runtime never blows its CPU budget solving a
 * challenge that turned out to be too hard. */
const POW_MAX_DIFFICULTY = 18;
const POW_MAX_ATTEMPTS = 60_000;
const POW_TIME_BUDGET_MS = 3_000;

async function solveFileDitchPow(challenge: string, difficulty: number) {
  const encoder = new TextEncoder();
  const startedAt = Date.now();
  for (let nonce = 0; nonce < POW_MAX_ATTEMPTS; nonce += 1) {
    if ((nonce & 1023) === 0 && Date.now() - startedAt > POW_TIME_BUDGET_MS) break;
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${challenge}:${nonce}`));
    if (leadingZeroBits(new Uint8Array(digest), difficulty)) return String(nonce);
  }
  throw new Error("FileDitch browser verification took too long — open the link once in a browser");
}


function fileDitchDirectUrl(html: string) {
  const match = html.match(/var\s+u\s*=\s*(\[[\s\S]*?\])\.join\(["']{2}\)/i);
  if (!match?.[1]) return "";
  try {
    const parts = JSON.parse(match[1]) as unknown;
    return Array.isArray(parts) && parts.every((part) => typeof part === "string")
      ? parts.join("")
      : "";
  } catch {
    return "";
  }
}

/** Overall guard rails for a batch of FileDitch links: the browser check is
 * CPU heavy, so cap how many we solve and how long the batch may take. */
const FILEDITCH_MAX_ITEMS = 10;
const FILEDITCH_TOTAL_BUDGET_MS = 8_000;

/** FileDitch share URLs now return a small HTML page. Complete its lightweight
 * browser check and extract the temporary, signed media URL embedded in it. */
async function resolveFileDitchItems(found: Map<string, PixeldrainItem>) {
  const items = [...found.values()].filter((item) => item.host === "fileditch");
  const startedAt = Date.now();
  let solved = 0;
  // Sequential on purpose: each verification can be CPU heavy, and solving
  // several at once trips the hosting runtime's CPU budget.
  for (const item of items) {
    if (solved >= FILEDITCH_MAX_ITEMS) break;
    if (Date.now() - startedAt > FILEDITCH_TOTAL_BUDGET_MS) break;
    const headers = { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" };
    try {
      const first = await fetch(item.pageUrl, { headers, redirect: "follow" });
      if (!first.ok) continue;
      let html = await first.text();
      let directUrl = fileDitchDirectUrl(html);

      if (!directUrl) {
        const fields = fileDitchPowFields(html);
        const challenge = fields["pow_challenge"];
        const difficulty = Number(fields["pow_diff"]);
        if (!challenge || !Number.isInteger(difficulty) || difficulty < 1) continue;
        if (difficulty > POW_MAX_DIFFICULTY) continue;
        fields["pow_nonce"] = await solveFileDitchPow(challenge, difficulty);
        solved += 1;
        const verified = await fetch(first.url || item.pageUrl, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(fields).toString(),
          redirect: "follow",
        });
        if (!verified.ok) continue;
        html = await verified.text();
        directUrl = fileDitchDirectUrl(html);
      }

      if (directUrl.startsWith("https://")) item.directUrl = directUrl;
    } catch {
      /* leave this item on its page URL; the rest of the batch still works */
    }
  }
}



async function resolveItemMetadata(
  found: Map<string, PixeldrainItem>,
  hostFilter?: "pixeldrain" | "fileditch",
) {
  // When a single host is selected from a .dlc, only resolve that host and
  // skip the others — FileDitch's browser check is CPU-heavy, so avoiding
  // it when the user only wants Pixeldrain keeps the worker within budget.
  const tasks: Promise<unknown>[] = [];
  if (!hostFilter || hostFilter === "pixeldrain") tasks.push(namePixeldrainItems(found));
  if (!hostFilter || hostFilter === "fileditch") tasks.push(resolveFileDitchItems(found));
  await Promise.all(tasks);
}

export async function scrapeUrl(
  url: string,
  deep: boolean,
  maxPages: number,
): Promise<ScrapeResult> {
  const found = new Map<string, PixeldrainItem>();
  const pagesScanned: string[] = [];
  const protectedPages = new Set<string>();

  const first = await fetchPage(url);
  if (!first.ok) throw new Error(`Failed to fetch page (HTTP ${first.status})`);
  pagesScanned.push(first.finalUrl);
  extract(first.html, first.finalUrl, found);
  if (isProtected(first.finalUrl)) protectedPages.add(first.finalUrl);

  if (deep) {
    const origin = new URL(first.finalUrl).origin;
    const candidates = collectLinks(first.html, first.finalUrl).filter((u) => {
      if (isFileHostUrl(u)) return false;
      if (/\.(css|js|png|jpe?g|gif|svg|webp|ico|woff2?|mp4|zip)(\?|$)/i.test(u)) return false;
      return true;
    });

    for (const link of candidates) {
      if (pagesScanned.length >= maxPages) break;
      if (isProtected(link)) {
        protectedPages.add(link);
        continue;
      }
      const sameSite = link.startsWith(origin);
      let shortish = false;
      try {
        shortish = new URL(link).pathname.length <= 40;
      } catch {
        continue;
      }
      if (!sameSite && !shortish) continue;

      try {
        const page = await fetchPage(link);
        if (!page.ok) continue;
        pagesScanned.push(page.finalUrl);
        if (isProtected(page.finalUrl)) {
          protectedPages.add(page.finalUrl);
          continue;
        }
        extract(page.html, page.finalUrl, found);
      } catch {
        /* skip unreachable link */
      }
    }
  }

  await resolveItemMetadata(found);

  return {
    sourceUrl: first.finalUrl,
    items: [...found.values()],
    pagesScanned,
    protectedPages: [...protectedPages],
    scrapedAt: new Date().toISOString(),
  };
}

/**
 * Decrypt a .dlc link container through the public dcrypt.it service, then
 * pull Pixeldrain links out of the resulting URL list (following non-protected
 * intermediate pages when asked).
 */
export async function resolveDlc(
  base64Content: string,
  filename: string,
  follow: boolean,
  hostFilter?: "pixeldrain" | "fileditch",
): Promise<ScrapeResult> {
  const found = new Map<string, PixeldrainItem>();
  const pagesScanned: string[] = [];
  const protectedPages = new Set<string>();

  const res = await fetch("https://dcrypt.it/decrypt/paste", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: new URLSearchParams({ content: base64Content }).toString(),
  });
  if (!res.ok) throw new Error(`DLC decrypt service failed (HTTP ${res.status})`);

  const json = (await res.json()) as {
    success?: { links?: string[] };
    form_errors?: Record<string, string[] | string>;
    error?: string;
  };
  const links = json.success?.links ?? [];
  if (!links.length) {
    const formError = Object.values(json.form_errors ?? {})
      .flat()
      .join(" ");
    throw new Error(
      json.error ||
        formError ||
        "Could not decrypt that container — it may be expired or not a valid .dlc file",
    );
  }

  extract(links.join("\n"), filename, found);

  for (const link of links) {
    if (isFileHostUrl(link)) continue;
    if (isProtected(link)) {
      protectedPages.add(link);
      continue;
    }
    if (!follow || pagesScanned.length >= 20) continue;
    try {
      const page = await fetchPage(link);
      if (!page.ok) continue;
      pagesScanned.push(page.finalUrl);
      if (isProtected(page.finalUrl)) protectedPages.add(page.finalUrl);
      else extract(page.html, page.finalUrl, found);
    } catch {
      /* skip unreachable link */
    }
  }

  await resolveItemMetadata(found, hostFilter);

  return {
    sourceUrl: filename,
    items: [...found.values()],
    pagesScanned,
    protectedPages: [...protectedPages],
    scrapedAt: new Date().toISOString(),
  };
}

/**
 * Resolve a manually pasted blob: it can be a Pixeldrain URL, a page URL to
 * fetch, or raw HTML/text copied out of a solved captcha page.
 */
export async function resolvePasted(input: string, label: string): Promise<ScrapeResult> {
  const trimmed = input.trim();
  const found = new Map<string, PixeldrainItem>();
  const pagesScanned: string[] = [];
  const protectedPages = new Set<string>();

  // Always scan the pasted text itself first.
  extract(trimmed, label || "pasted content", found);

  const looksLikeSingleUrl = /^https?:\/\/\S+$/i.test(trimmed);
  if (looksLikeSingleUrl && !isFileHostUrl(trimmed)) {
    if (isProtected(trimmed)) {
      protectedPages.add(trimmed);
    } else {
      try {
        const page = await fetchPage(trimmed);
        if (page.ok) {
          pagesScanned.push(page.finalUrl);
          if (isProtected(page.finalUrl)) protectedPages.add(page.finalUrl);
          else extract(page.html, page.finalUrl, found);
        }
      } catch {
        /* ignore fetch failure, pasted text scan still applies */
      }
    }
  }

  await resolveItemMetadata(found);

  return {
    sourceUrl: label || (looksLikeSingleUrl ? trimmed : "pasted content"),
    items: [...found.values()],
    pagesScanned,
    protectedPages: [...protectedPages],
    scrapedAt: new Date().toISOString(),
  };
}

import {
  UA,
  collectLinks,
  extract,
  isProtected,
  isFileHostUrl,
  isOptionalName,
  type PixeldrainItem,
  type ScrapeResult,
} from "./pixeldrain-extract.ts";
import { fetchText, validateFetchUrl } from "./fetch.server.ts";

function isFileCryptUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return (
      host === "filecrypt.cc" ||
      host === "filecrypt.co" ||
      host.endsWith(".filecrypt.cc") ||
      host.endsWith(".filecrypt.co")
    );
  } catch {
    return false;
  }
}

function isFitgirlSource(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "fitgirl-repacks.site" || host.endsWith(".fitgirl-repacks.site");
  } catch {
    return false;
  }
}

async function fetchPage(url: string) {
  const res = await fetchText(
    url,
    {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
    },
    true,
  );
  return { ...res, html: res.text };
}

function scanPage(
  html: string,
  url: string,
  found: Map<string, PixeldrainItem>,
  protectedPages: Set<string>,
) {
  extract(html, url, found);
  for (const link of collectLinks(html, url)) {
    if (isProtected(link) && !(isFitgirlSource(url) && isFileCryptUrl(link))) {
      protectedPages.add(link);
    }
  }
}

/**
 * Ask Pixeldrain for the real filename of each file/list so wget can save it
 * under the right name instead of the API path.
 */
async function namePixeldrainItems(found: Map<string, PixeldrainItem>) {
  const queue = [...found.values()].filter((i) => i.host === "pixeldrain" && !i.filename);
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      let item: PixeldrainItem | undefined;
      while ((item = queue.shift())) {
        const url =
          item.kind === "file"
            ? `https://pixeldrain.com/api/file/${item.id}/info`
            : `https://pixeldrain.com/api/list/${item.id}`;
        try {
          const res = await fetchText(url, {
            headers: { "User-Agent": UA, Accept: "application/json" },
          });
          if (!res.ok) continue;
          const json = JSON.parse(res.text) as { name?: unknown; title?: unknown };
          const rawName = json.name ?? json.title;
          const name = typeof rawName === "string" ? rawName.trim() : "";
          if (!name) continue;
          item.filename =
            item.kind === "list"
              ? `${name.replace(/[/\\]/g, "_")}.zip`
              : name.replace(/[/\\]/g, "_");
          item.optional = isOptionalName(item.filename);
        } catch {
          /* keep the default filename behaviour */
        }
      }
    }),
  );
}

async function resolveItemMetadata(
  found: Map<string, PixeldrainItem>,
  hostFilter?: "pixeldrain" | "fileditch" | "filekeeper",
) {
  // FileDitch proof-of-work must not run in the hosted request: even a small
  // challenge can exceed its CPU allowance. Its generated download command
  // performs verification locally immediately before downloading instead.
  if (!hostFilter || hostFilter === "pixeldrain") await namePixeldrainItems(found);
}

export async function scrapeUrl(
  url: string,
  deep: boolean,
  maxPages: number,
): Promise<ScrapeResult> {
  validateFetchUrl(url);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 40) {
    throw new Error("maxPages must be an integer between 1 and 40.");
  }
  if (isFileHostUrl(url) || isProtected(url)) return resolvePasted(url, url);
  const found = new Map<string, PixeldrainItem>();
  const pagesScanned: string[] = [];
  const protectedPages = new Set<string>();

  const first = await fetchPage(url);
  if (!first.ok) throw new Error(`Failed to fetch page (HTTP ${first.status})`);
  pagesScanned.push(first.finalUrl);
  extract(first.finalUrl, first.finalUrl, found);
  scanPage(first.html, first.finalUrl, found, protectedPages);
  if (isProtected(first.finalUrl)) protectedPages.add(first.finalUrl);

  if (deep) {
    const origin = new URL(first.finalUrl).origin;
    const candidates = collectLinks(first.html, first.finalUrl).filter((u) => {
      if (isFileHostUrl(u)) return false;
      if (/\.(css|js|png|jpe?g|gif|svg|webp|ico|woff2?|mp4|zip)(\?|$)/i.test(u)) return false;
      return true;
    });

    const attempted = new Set([url, first.finalUrl]);
    let attempts = 1;
    for (const link of candidates) {
      if (attempts >= maxPages) break;
      if (attempted.has(link)) continue;
      if (isProtected(link)) {
        if (!(isFitgirlSource(url) && isFileCryptUrl(link))) protectedPages.add(link);
        continue;
      }
      const sameSite = new URL(link).origin === origin;
      let shortish = false;
      try {
        shortish = new URL(link).pathname.length <= 40;
      } catch {
        continue;
      }
      if (!sameSite && !shortish) continue;

      attempted.add(link);
      attempts++;
      try {
        const page = await fetchPage(link);
        if (!page.ok) continue;
        pagesScanned.push(page.finalUrl);
        if (isProtected(page.finalUrl)) {
          protectedPages.add(page.finalUrl);
          continue;
        }
        extract(page.finalUrl, page.finalUrl, found);
        scanPage(page.html, page.finalUrl, found, protectedPages);
      } catch {
        /* skip unreachable link */
      }
    }
  }

  await resolveItemMetadata(found);

  if (isFitgirlSource(url)) {
    for (const [key, item] of found.entries()) {
      if (item.host !== "filekeeper") {
        found.delete(key);
      }
    }
    for (const link of [...protectedPages]) {
      if (isFileCryptUrl(link)) protectedPages.delete(link);
    }
  }

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
  hostFilter?: "pixeldrain" | "fileditch" | "filekeeper",
): Promise<ScrapeResult> {
  const found = new Map<string, PixeldrainItem>();
  const pagesScanned: string[] = [];
  const protectedPages = new Set<string>();

  const res = await fetchText("https://dcrypt.it/decrypt/paste", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: new URLSearchParams({ content: base64Content }).toString(),
  });
  if (!res.ok) throw new Error(`DLC decrypt service failed (HTTP ${res.status})`);

  const json = JSON.parse(res.text) as {
    success?: { links?: string[] };
    form_errors?: Record<string, string[] | string>;
    error?: string;
  };
  const links = Array.isArray(json.success?.links)
    ? [
        ...new Set(
          json.success.links.filter(
            (link) => typeof link === "string" && /^https?:\/\//i.test(link),
          ),
        ),
      ]
    : [];
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

  let attempts = 0;
  for (const link of links) {
    if (isFileHostUrl(link)) continue;
    if (isProtected(link)) {
      if (!(isFitgirlSource(filename) && isFileCryptUrl(link))) protectedPages.add(link);
      continue;
    }
    if (!follow || attempts >= 20) continue;
    attempts++;
    try {
      const page = await fetchPage(link);
      if (!page.ok) continue;
      pagesScanned.push(page.finalUrl);
      if (isProtected(page.finalUrl)) protectedPages.add(page.finalUrl);
      else {
        extract(page.finalUrl, page.finalUrl, found);
        scanPage(page.html, page.finalUrl, found, protectedPages);
      }
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
  scanPage(trimmed, label || "pasted content", found, protectedPages);

  const looksLikeSingleUrl = /^https?:\/\/\S+$/i.test(trimmed);
  if (looksLikeSingleUrl && !isFileHostUrl(trimmed)) {
    if (isProtected(trimmed)) {
      protectedPages.add(trimmed);
    } else {
      const page = await fetchPage(trimmed);
      if (!page.ok) throw new Error(`Failed to fetch page (HTTP ${page.status})`);
      pagesScanned.push(page.finalUrl);
      if (isProtected(page.finalUrl)) protectedPages.add(page.finalUrl);
      else {
        extract(page.finalUrl, page.finalUrl, found);
        scanPage(page.html, page.finalUrl, found, protectedPages);
      }
    }
  }

  await resolveItemMetadata(found);

  if (isFitgirlSource(label) || isFitgirlSource(input)) {
    for (const [key, item] of found.entries()) {
      if (item.host !== "filekeeper") {
        found.delete(key);
      }
    }
    for (const link of [...protectedPages]) {
      if (isFileCryptUrl(link)) protectedPages.delete(link);
    }
  }

  return {
    sourceUrl: label || (looksLikeSingleUrl ? trimmed : "pasted content"),
    items: [...found.values()],
    pagesScanned,
    protectedPages: [...protectedPages],
    scrapedAt: new Date().toISOString(),
  };
}

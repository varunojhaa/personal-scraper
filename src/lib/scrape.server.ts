import {
  UA,
  collectLinks,
  extract,
  isProtected,
  type PixeldrainItem,
  type ScrapeResult,
} from "./pixeldrain-extract";

async function fetchPage(url: string) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
  });
  const type = res.headers.get("content-type") ?? "";
  const html = type.includes("html") || type.includes("text") || type === "" ? await res.text() : "";
  return { ok: res.ok, status: res.status, finalUrl: res.url || url, html };
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
      if (u.includes("pixeldrain.com")) return false;
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
): Promise<ScrapeResult> {
  const found = new Map<string, PixeldrainItem>();
  const pagesScanned: string[] = [];
  const protectedPages = new Set<string>();

  const res = await fetch("http://dcrypt.it/decrypt/paste", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: new URLSearchParams({ content: base64Content }).toString(),
  });
  if (!res.ok) throw new Error(`DLC decrypt service failed (HTTP ${res.status})`);

  const json = (await res.json()) as {
    success?: { links?: string[] };
    form_errors?: Record<string, unknown>;
    error?: string;
  };
  const links = json.success?.links ?? [];
  if (!links.length) {
    throw new Error(
      json.error || "Could not decrypt that container — it may be expired or not a valid .dlc file",
    );
  }

  extract(links.join("\n"), filename, found);

  for (const link of links) {
    if (link.includes("pixeldrain.com")) continue;
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
  if (looksLikeSingleUrl && !trimmed.includes("pixeldrain.com")) {
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

  return {
    sourceUrl: label || (looksLikeSingleUrl ? trimmed : "pasted content"),
    items: [...found.values()],
    pagesScanned,
    protectedPages: [...protectedPages],
    scrapedAt: new Date().toISOString(),
  };
}

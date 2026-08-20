import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type PixeldrainItem = {
  id: string;
  kind: "file" | "list";
  pageUrl: string;
  directUrl: string;
  foundOn: string;
};

export type ScrapeResult = {
  sourceUrl: string;
  items: PixeldrainItem[];
  pagesScanned: string[];
  protectedPages: string[];
  scrapedAt: string;
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const inputSchema = z.object({
  url: z.string().url(),
  deep: z.boolean().optional().default(false),
  maxPages: z.number().int().min(1).max(40).optional().default(20),
});

// Sites that wrap links behind captcha / JS challenges. We cannot resolve
// these automatically — we only report them so the user can open them.
const PROTECTED_HOSTS = [
  "filecrypt.cc",
  "filecrypt.co",
  "viewcrate.cc",
  "linkvertise.com",
  "ouo.io",
  "safelinku.com",
  "shorte.st",
  "adf.ly",
];

function extract(html: string, foundOn: string, into: Map<string, PixeldrainItem>) {
  const patterns: Array<{ re: RegExp; kind: "file" | "list" }> = [
    { re: /pixeldrain\.com\/(?:u|api\/file)\/([A-Za-z0-9]{4,12})/g, kind: "file" },
    { re: /pixeldrain\.com\/l\/([A-Za-z0-9]{4,12})/g, kind: "list" },
  ];
  for (const { re, kind } of patterns) {
    for (const m of html.matchAll(re)) {
      const id = m[1] as string;
      const key = `${kind}:${id}`;
      if (into.has(key)) continue;
      into.set(key, {
        id,
        kind,
        foundOn,
        pageUrl:
          kind === "file" ? `https://pixeldrain.com/u/${id}` : `https://pixeldrain.com/l/${id}`,
        directUrl:
          kind === "file"
            ? `https://pixeldrain.com/api/file/${id}?download`
            : `https://pixeldrain.com/api/list/${id}/zip`,
      });
    }
  }
}

function collectLinks(html: string, base: string) {
  const out = new Set<string>();
  const re = /(?:href|data-href|data-url|content)\s*=\s*["']([^"']+)["']/gi;
  for (const m of html.matchAll(re)) {
    const raw = (m[1] ?? "").trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("javascript:") || raw.startsWith("mailto:"))
      continue;
    try {
      const abs = new URL(raw, base).toString();
      if (abs.startsWith("http")) out.add(abs.split("#")[0] as string);
    } catch {
      /* ignore bad urls */
    }
  }
  // Bare URLs inside scripts / JSON blobs
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>\\)]{8,300}/g)) {
    out.add((m[0] ?? "").replace(/[.,;]+$/, ""));
  }
  return [...out];
}

function isProtected(url: string) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    return PROTECTED_HOSTS.some((p) => h === p || h.endsWith(`.${p}`));
  } catch {
    return false;
  }
}

async function fetchPage(url: string) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
  });
  const type = res.headers.get("content-type") ?? "";
  const html = type.includes("html") || type.includes("text") || type === "" ? await res.text() : "";
  return { ok: res.ok, status: res.status, finalUrl: res.url || url, html };
}

export const scrapePixeldrain = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => inputSchema.parse(data))
  .handler(async ({ data }): Promise<ScrapeResult> => {
    const found = new Map<string, PixeldrainItem>();
    const pagesScanned: string[] = [];
    const protectedPages = new Set<string>();

    const first = await fetchPage(data.url);
    if (!first.ok) throw new Error(`Failed to fetch page (HTTP ${first.status})`);
    pagesScanned.push(first.finalUrl);
    extract(first.html, first.finalUrl, found);
    if (isProtected(first.finalUrl)) protectedPages.add(first.finalUrl);

    if (data.deep) {
      const origin = new URL(first.finalUrl).origin;
      const candidates = collectLinks(first.html, first.finalUrl).filter((u) => {
        if (u.includes("pixeldrain.com")) return false;
        if (/\.(css|js|png|jpe?g|gif|svg|webp|ico|woff2?|mp4|zip)(\?|$)/i.test(u)) return false;
        return true;
      });

      for (const link of candidates) {
        if (pagesScanned.length >= data.maxPages) break;
        if (isProtected(link)) {
          protectedPages.add(link);
          continue;
        }
        // Follow same-site pages and any short/redirect style links.
        const sameSite = link.startsWith(origin);
        const shortish = new URL(link).pathname.length <= 40;
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
  });

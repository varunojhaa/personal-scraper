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

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Sites that wrap links behind captcha / JS challenges. We cannot resolve
// these automatically — we only report them so the user can open them.
export const PROTECTED_HOSTS = [
  "filecrypt.cc",
  "filecrypt.co",
  "viewcrate.cc",
  "linkvertise.com",
  "ouo.io",
  "safelinku.com",
  "shorte.st",
  "adf.ly",
];

export function extract(html: string, foundOn: string, into: Map<string, PixeldrainItem>) {
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

export function collectLinks(html: string, base: string) {
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
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>\\)]{8,300}/g)) {
    out.add((m[0] ?? "").replace(/[.,;]+$/, ""));
  }
  return [...out];
}

export function isProtected(url: string) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    return PROTECTED_HOSTS.some((p) => h === p || h.endsWith(`.${p}`));
  } catch {
    return false;
  }
}

export function buildWget(items: PixeldrainItem[]) {
  return items.map((i) => `wget --content-disposition -c "${i.directUrl}"`).join("\n");
}

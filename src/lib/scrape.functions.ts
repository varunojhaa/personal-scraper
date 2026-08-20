import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type PixeldrainItem = {
  id: string;
  kind: "file" | "list";
  pageUrl: string;
  directUrl: string;
};

const inputSchema = z.object({ url: z.string().url() });

export const scrapePixeldrain = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => inputSchema.parse(data))
  .handler(async ({ data }) => {
    const res = await fetch(data.url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,*/*",
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch page (HTTP ${res.status})`);
    }

    const html = await res.text();
    const found = new Map<string, PixeldrainItem>();

    const patterns: Array<{ re: RegExp; kind: "file" | "list" }> = [
      { re: /pixeldrain\.com\/(?:u|api\/file)\/([A-Za-z0-9]{4,12})/g, kind: "file" },
      { re: /pixeldrain\.com\/l\/([A-Za-z0-9]{4,12})/g, kind: "list" },
    ];

    for (const { re, kind } of patterns) {
      for (const m of html.matchAll(re)) {
        const id = m[1];
        const key = `${kind}:${id}`;
        if (found.has(key)) continue;
        found.set(key, {
          id,
          kind,
          pageUrl:
            kind === "file"
              ? `https://pixeldrain.com/u/${id}`
              : `https://pixeldrain.com/l/${id}`,
          directUrl:
            kind === "file"
              ? `https://pixeldrain.com/api/file/${id}?download`
              : `https://pixeldrain.com/api/list/${id}/zip`,
        });
      }
    }

    return {
      sourceUrl: data.url,
      items: [...found.values()],
      scrapedAt: new Date().toISOString(),
    };
  });

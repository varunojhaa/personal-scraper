import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { ScrapeResult } from "./pixeldrain-extract";

export type { PixeldrainItem, ScrapeResult } from "./pixeldrain-extract";

export const scrapePixeldrain = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        url: z.string().url(),
        deep: z.boolean().optional().default(false),
        maxPages: z.number().int().min(1).max(40).optional().default(20),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<ScrapeResult> => {
    const { scrapeUrl } = await import("./scrape.server");
    return scrapeUrl(data.url, data.deep, data.maxPages);
  });

export const resolvePastedContent = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        content: z.string().min(3).max(2_000_000),
        label: z.string().max(500).optional().default(""),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<ScrapeResult> => {
    const { resolvePasted } = await import("./scrape.server");
    return resolvePasted(data.content, data.label);
  });

export const resolveDlcContainer = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        base64: z.string().min(16).max(8_000_000),
        filename: z.string().max(300).optional().default("container.dlc"),
        follow: z.boolean().optional().default(true),
        hostFilter: z.enum(["pixeldrain", "fileditch"]).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<ScrapeResult> => {
    const { resolveDlc } = await import("./scrape.server");
    return resolveDlc(data.base64, data.filename, data.follow, data.hostFilter);
  });

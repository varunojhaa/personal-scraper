import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Download, Link2, Loader2, Copy, Check, Terminal, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Toaster } from "@/components/ui/sonner";
import { scrapePixeldrain, type PixeldrainItem } from "@/lib/scrape.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Pixeldrain Link Scraper & wget Command Builder" },
      {
        name: "description",
        content:
          "Paste any page URL to extract every Pixeldrain file and list link, then copy a ready-to-run wget download command.",
      },
      { property: "og:title", content: "Pixeldrain Link Scraper & wget Command Builder" },
      {
        property: "og:description",
        content:
          "Extract all Pixeldrain links from any web page and generate wget download commands instantly.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function buildWget(items: PixeldrainItem[]) {
  return items
    .map(
      (i) =>
        `wget --content-disposition -c "${i.directUrl}"`,
    )
    .join("\n");
}

function Index() {
  const [url, setUrl] = useState("");
  const [deep, setDeep] = useState(true);
  const [copied, setCopied] = useState(false);
  const scrape = useServerFn(scrapePixeldrain);

  const mutation = useMutation({
    mutationFn: (target: string) => scrape({ data: { url: target, deep } }),
    onError: (e: Error) => toast.error(e.message || "Scrape failed"),
    onSuccess: (d) =>
      toast.success(`Found ${d.items.length} Pixeldrain link${d.items.length === 1 ? "" : "s"}`),
  });

  const items = mutation.data?.items ?? [];
  const blocked = mutation.data?.protectedPages ?? [];
  const scanned = mutation.data?.pagesScanned ?? [];
  const command = useMemo(() => buildWget(items), [items]);

  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    toast.success("Command copied");
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <main className="min-h-screen bg-background">
      <Toaster />
      <div
        className="border-b border-border"
        style={{ backgroundImage: "var(--gradient-hero)" }}
      >
        <div className="mx-auto max-w-4xl px-6 py-16">
          <Badge variant="outline" className="mb-4 gap-1.5">
            <Terminal className="h-3.5 w-3.5" /> scraper
          </Badge>
          <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
            Pixeldrain link scraper
          </h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Paste any page. It scans that page and, with deep scan on, follows its sub-pages and
            redirects to collect every Pixeldrain file or list, then builds one wget command.
          </p>

          <form
            className="mt-8 flex flex-col gap-3 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (url.trim()) mutation.mutate(url.trim());
            }}
          >
            <div className="relative flex-1">
              <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/page-with-links"
                className="h-12 pl-9"
              />
            </div>
            <Button type="submit" size="lg" disabled={mutation.isPending} className="h-12">
              {mutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Scraping
                </>
              ) : (
                <>
                  <Download className="h-4 w-4" /> Scrape links
                </>
              )}
            </Button>
          </form>

          <label className="mt-4 flex items-center gap-3 text-sm text-muted-foreground">
            <Switch checked={deep} onCheckedChange={setDeep} />
            Deep scan — follow sub-pages and redirects (up to 20 pages, slower)
          </label>
        </div>
      </div>


      <div className="mx-auto max-w-4xl px-6 py-12">
        {mutation.isSuccess && items.length === 0 && (
          <p className="rounded-lg border border-border bg-card p-6 text-center text-muted-foreground">
            No Pixeldrain links found on that page.
          </p>
        )}

        {items.length > 0 && (
          <div className="grid gap-6">
            <Card>
              <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
                <CardTitle className="text-base">wget command ({items.length})</CardTitle>
                <Button variant="secondary" size="sm" onClick={copy}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </CardHeader>
              <CardContent>
                <Textarea
                  readOnly
                  value={command}
                  rows={Math.min(items.length + 1, 14)}
                  className="resize-y text-xs"
                  style={{ fontFamily: "var(--font-mono-stack)" }}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Found links</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-2">
                {items.map((i) => (
                  <div
                    key={`${i.kind}-${i.id}`}
                    className="flex items-center justify-between gap-3 rounded-md border border-border bg-secondary/40 px-3 py-2"
                  >
                    <a
                      href={i.pageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-sm text-accent hover:underline"
                      style={{ fontFamily: "var(--font-mono-stack)" }}
                    >
                      {i.pageUrl}
                    </a>
                    <Badge variant={i.kind === "list" ? "secondary" : "default"}>{i.kind}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </main>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  Download,
  Link2,
  Loader2,
  Copy,
  Check,
  Terminal,
  ShieldAlert,
  ExternalLink,
  ClipboardPaste,
  Trash2,
  FileDown,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Toaster } from "@/components/ui/sonner";
import { scrapePixeldrain, resolvePastedContent } from "@/lib/scrape.functions";
import {
  buildWget,
  buildIdmList,
  buildIdmEf2,
  type PixeldrainItem,
  type ScrapeResult,
} from "@/lib/pixeldrain-extract";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Pixeldrain Link Scraper & wget Command Builder" },
      {
        name: "description",
        content:
          "Scrape Pixeldrain links from any page, resolve captcha-protected containers by hand, and generate ready-to-run wget download commands.",
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

type PendingPage = { url: string; status: "open-me" | "resolved" };

function Index() {
  const [url, setUrl] = useState("");
  const [deep, setDeep] = useState(true);
  const [copied, setCopied] = useState(false);
  const [copiedIdm, setCopiedIdm] = useState(false);
  const [items, setItems] = useState<PixeldrainItem[]>([]);
  const [pending, setPending] = useState<PendingPage[]>([]);
  const [scannedCount, setScannedCount] = useState(0);
  const [activePaste, setActivePaste] = useState<string | null>(null);
  const [pasteValue, setPasteValue] = useState("");

  const scrape = useServerFn(scrapePixeldrain);
  const resolvePaste = useServerFn(resolvePastedContent);

  const merge = (result: ScrapeResult) => {
    setItems((prev) => {
      const map = new Map(prev.map((i) => [`${i.kind}:${i.id}`, i]));
      for (const i of result.items) map.set(`${i.kind}:${i.id}`, i);
      return [...map.values()];
    });
    setScannedCount((n) => n + result.pagesScanned.length);
    if (result.protectedPages.length) {
      setPending((prev) => {
        const known = new Set(prev.map((p) => p.url));
        const next = [...prev];
        for (const u of result.protectedPages)
          if (!known.has(u)) next.push({ url: u, status: "open-me" });
        return next;
      });
    }
    return result;
  };

  const scrapeMutation = useMutation({
    mutationFn: (target: string) => scrape({ data: { url: target, deep } }),
    onError: (e: Error) => toast.error(e.message || "Scrape failed"),
    onSuccess: (d) => {
      merge(d);
      toast.success(
        `${d.items.length} link${d.items.length === 1 ? "" : "s"} found${
          d.protectedPages.length ? ` · ${d.protectedPages.length} page(s) need you` : ""
        }`,
      );
    },
  });

  const pasteMutation = useMutation({
    mutationFn: (vars: { content: string; label: string }) => resolvePaste({ data: vars }),
    onError: (e: Error) => toast.error(e.message || "Could not read pasted content"),
    onSuccess: (d, vars) => {
      merge(d);
      if (d.items.length === 0) {
        toast.error("No Pixeldrain links in that paste");
        return;
      }
      setPending((prev) =>
        prev.map((p) => (p.url === vars.label ? { ...p, status: "resolved" } : p)),
      );
      setActivePaste(null);
      setPasteValue("");
      toast.success(`Added ${d.items.length} link${d.items.length === 1 ? "" : "s"}`);
    },
  });

  const command = useMemo(() => buildWget(items), [items]);
  const idmList = useMemo(() => buildIdmList(items), [items]);
  const openMe = pending.filter((p) => p.status === "open-me");

  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    toast.success("Command copied");
    setTimeout(() => setCopied(false), 1600);
  };

  const copyIdm = async () => {
    await navigator.clipboard.writeText(idmList);
    setCopiedIdm(true);
    toast.success("URLs copied — paste into IDM batch download");
    setTimeout(() => setCopiedIdm(false), 1600);
  };

  const downloadEf2 = () => {
    const blob = new Blob([buildIdmEf2(items)], { type: "text/plain" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = "pixeldrain-idm.ef2";
    a.click();
    URL.revokeObjectURL(href);
    toast.success("Exported pixeldrain-idm.ef2");
  };

  const submitPaste = (label: string) => {
    if (pasteValue.trim().length < 3) return;
    pasteMutation.mutate({ content: pasteValue, label });
  };

  const resetAll = () => {
    setItems([]);
    setPending([]);
    setScannedCount(0);
    setActivePaste(null);
    setPasteValue("");
  };

  return (
    <main className="min-h-screen bg-background">
      <Toaster />
      <div className="border-b border-border" style={{ backgroundImage: "var(--gradient-hero)" }}>
        <div className="mx-auto max-w-4xl px-6 py-16">
          <Badge variant="outline" className="mb-4 gap-1.5">
            <Terminal className="h-3.5 w-3.5" /> scraper
          </Badge>
          <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
            Pixeldrain link scraper
          </h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Scan a page for Pixeldrain files and lists. Captcha-protected containers get flagged as
            &quot;open me&quot; — solve them yourself, paste the result back, and everything merges
            into one wget command.
          </p>

          <form
            className="mt-8 flex flex-col gap-3 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (url.trim()) scrapeMutation.mutate(url.trim());
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
            <Button type="submit" size="lg" disabled={scrapeMutation.isPending} className="h-12">
              {scrapeMutation.isPending ? (
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
        {(items.length > 0 || pending.length > 0) && (
          <div className="mb-6 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {scannedCount} page{scannedCount === 1 ? "" : "s"} scanned · {items.length} link
              {items.length === 1 ? "" : "s"} collected
            </span>
            <Button variant="ghost" size="sm" onClick={resetAll}>
              <Trash2 className="h-3.5 w-3.5" /> Clear session
            </Button>
          </div>
        )}

        {pending.length > 0 && (
          <Card className="mb-6 border-destructive/40">
            <CardHeader className="flex-row items-center gap-2 space-y-0">
              <ShieldAlert className="h-4 w-4 text-destructive" />
              <CardTitle className="text-base">
                Open me — captcha-protected pages ({openMe.length} left)
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <p className="text-sm text-muted-foreground">
                These hide links behind a captcha, so they can&apos;t be read automatically. Open
                one, solve it, then paste the Pixeldrain link it reveals — or the whole page HTML
                (Ctrl+U → Ctrl+A → Ctrl+C) — back here.
              </p>

              {pending.map((p) => (
                <div key={p.url} className="rounded-md border border-border bg-secondary/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span
                      className="min-w-0 flex-1 truncate text-sm"
                      style={{ fontFamily: "var(--font-mono-stack)" }}
                    >
                      {p.url}
                    </span>
                    <div className="flex items-center gap-2">
                      <Badge variant={p.status === "resolved" ? "default" : "secondary"}>
                        {p.status === "resolved" ? "resolved" : "open me"}
                      </Badge>
                      <Button variant="outline" size="sm" asChild>
                        <a href={p.url} target="_blank" rel="noreferrer">
                          <ExternalLink className="h-3.5 w-3.5" /> Open
                        </a>
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setActivePaste(activePaste === p.url ? null : p.url);
                          setPasteValue("");
                        }}
                      >
                        <ClipboardPaste className="h-3.5 w-3.5" /> Paste result
                      </Button>
                    </div>
                  </div>

                  {activePaste === p.url && (
                    <div className="mt-3 grid gap-2">
                      <Textarea
                        autoFocus
                        rows={4}
                        value={pasteValue}
                        onChange={(e) => setPasteValue(e.target.value)}
                        placeholder="Paste the Pixeldrain link, the redirected URL, or the page HTML…"
                        className="text-xs"
                        style={{ fontFamily: "var(--font-mono-stack)" }}
                      />
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setActivePaste(null)}>
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          disabled={pasteMutation.isPending}
                          onClick={() => submitPaste(p.url)}
                        >
                          {pasteMutation.isPending ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Check className="h-3.5 w-3.5" />
                          )}
                          Extract links
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">Add links manually</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Textarea
              rows={3}
              value={activePaste === "__manual__" ? pasteValue : ""}
              onFocus={() => {
                if (activePaste !== "__manual__") {
                  setActivePaste("__manual__");
                  setPasteValue("");
                }
              }}
              onChange={(e) => setPasteValue(e.target.value)}
              placeholder="Paste any Pixeldrain links, a solved page URL, or raw HTML…"
              className="text-xs"
              style={{ fontFamily: "var(--font-mono-stack)" }}
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="secondary"
                disabled={pasteMutation.isPending || activePaste !== "__manual__"}
                onClick={() => submitPaste("manual paste")}
              >
                {pasteMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ClipboardPaste className="h-3.5 w-3.5" />
                )}
                Extract links
              </Button>
            </div>
          </CardContent>
        </Card>

        {scrapeMutation.isSuccess && items.length === 0 && pending.length === 0 && (
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
              <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
                <CardTitle className="text-base">IDM download list ({items.length})</CardTitle>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={copyIdm}>
                    {copiedIdm ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    {copiedIdm ? "Copied" : "Copy URLs"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={downloadEf2}>
                    <FileDown className="h-4 w-4" /> .ef2 file
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="grid gap-2">
                <p className="text-xs text-muted-foreground">
                  Copy the URLs, then in IDM use Tasks → Add Batch Download From Clipboard. Or grab
                  the .ef2 file and use File → Import → From IDM export file.
                </p>
                <Textarea
                  readOnly
                  value={idmList}
                  rows={Math.min(items.length + 1, 14)}
                  className="resize-y text-xs"
                  style={{ fontFamily: "var(--font-mono-stack)" }}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Collected links</CardTitle>
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

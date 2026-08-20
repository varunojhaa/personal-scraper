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
import {
  scrapePixeldrain,
  resolvePastedContent,
  resolveDlcContainer,
} from "@/lib/scrape.functions";
import {
  buildWget,
  buildIdmList,
  buildIdmEf2,
  HOST_LABELS,
  type PixeldrainItem,
  type ScrapeResult,
} from "@/lib/pixeldrain-extract";

type ToolMode = "auto" | "wget" | "idm";

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
  const [mode, setMode] = useState<ToolMode>("auto");
  const [onlyFuckingfast, setOnlyFuckingfast] = useState(false);
  const [includeOptional, setIncludeOptional] = useState(true);

  const scrape = useServerFn(scrapePixeldrain);
  const resolvePaste = useServerFn(resolvePastedContent);
  const resolveDlc = useServerFn(resolveDlcContainer);

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
      // FitGirl repacks are mirrored on three hosters; FuckingFast is the
      // fastest, so default to FuckingFast-only when scraping a FitGirl page.
      if (/fitgirl-repacks\.site/i.test(d.sourceUrl)) setOnlyFuckingfast(true);
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

  const dlcMutation = useMutation({
    mutationFn: async (file: File) => {
      // .dlc files are already base64 text — send the raw contents, don't re-encode.
      const base64 = (await file.text()).trim();
      return resolveDlc({ data: { base64, filename: file.name, follow: true } });
    },
    onError: (e: Error) => toast.error(e.message || "Could not read that container"),
    onSuccess: (d) => {
      merge(d);
      if (d.items.length === 0) {
        toast.error(
          d.protectedPages.length
            ? "Container decrypted, but its links are captcha-protected — see the open-me queue"
            : "No Pixeldrain links in that container",
        );
        return;
      }
      toast.success(
        `Added ${d.items.length} link${d.items.length === 1 ? "" : "s"} from container`,
      );
    },
  });

  const filteredItems = useMemo(() => {
    let out = onlyFuckingfast ? items.filter((i) => i.host === "fuckingfast") : items;
    if (!includeOptional) out = out.filter((i) => !i.optional);
    return out;
  }, [items, onlyFuckingfast, includeOptional]);
  const wgetItems = useMemo(
    () =>
      mode === "idm"
        ? []
        : mode === "wget"
          ? filteredItems
          : filteredItems.filter((i) => i.tool === "wget"),
    [filteredItems, mode],
  );
  const idmItems = useMemo(
    () =>
      mode === "wget"
        ? []
        : mode === "idm"
          ? filteredItems
          : filteredItems.filter((i) => i.tool === "idm"),
    [filteredItems, mode],
  );
  const command = useMemo(() => buildWget(wgetItems), [wgetItems]);
  const idmList = useMemo(() => buildIdmList(idmItems), [idmItems]);
  const openMe = pending.filter((p) => p.status === "open-me");

  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    toast.success("Command copied — paste it in a terminal to grab everything");
    setTimeout(() => setCopied(false), 1600);
  };

  const copyIdm = async () => {
    await navigator.clipboard.writeText(idmList);
    setCopiedIdm(true);
    toast.success("URLs copied — paste into IDM batch download");
    setTimeout(() => setCopiedIdm(false), 1600);
  };

  const downloadEf2 = () => {
    const blob = new Blob([buildIdmEf2(idmItems)], { type: "text/plain" });
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

        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">Upload a .dlc container</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              Drop a JDownloader <code>.dlc</code> link container here. It gets decrypted, then
              every Pixeldrain link inside is added to the wget and IDM lists.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Input
                type="file"
                accept=".dlc,.txt"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) dlcMutation.mutate(file);
                  e.target.value = "";
                }}
                disabled={dlcMutation.isPending}
                className="h-11 max-w-sm cursor-pointer file:mr-3 file:text-sm"
              />
              {dlcMutation.isPending && (
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Decrypting container…
                </span>
              )}
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
              <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
                <CardTitle className="text-base">Download tool</CardTitle>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch checked={onlyFuckingfast} onCheckedChange={setOnlyFuckingfast} />
                    FuckingFast only
                  </label>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch checked={includeOptional} onCheckedChange={setIncludeOptional} />
                    Include optional content
                  </label>
                  <div className="flex items-center gap-1 rounded-md border border-border p-1">
                    {(["auto", "wget", "idm"] as ToolMode[]).map((m) => (
                      <Button
                        key={m}
                        size="sm"
                        variant={mode === m ? "default" : "ghost"}
                        onClick={() => setMode(m)}
                      >
                        {m === "auto" ? "Auto" : m === "wget" ? "wget" : "IDM"}
                      </Button>
                    ))}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">
                  {onlyFuckingfast
                    ? "Filtered to FuckingFast links only — every other hoster is hidden from the export lists."
                    : "Auto sends Pixeldrain links to wget and every other hoster (FuckingFast, DataNodes, FileKeeper) to IDM. Pick wget or IDM to force all links into one list."}
                </p>
              </CardContent>
            </Card>

            {wgetItems.length > 0 && (
              <Card>
                <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
                  <CardTitle className="text-base">wget command ({wgetItems.length})</CardTitle>
                  <Button variant="secondary" size="sm" onClick={copy}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </CardHeader>
                <CardContent>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Copy this whole block and paste it into a terminal — it downloads every file,
                    with resume and correct filenames.
                  </p>
                  <Textarea
                    readOnly
                    value={command}
                    rows={Math.min(wgetItems.length + 2, 14)}
                    className="resize-y text-xs"
                    style={{ fontFamily: "var(--font-mono-stack)" }}
                  />
                </CardContent>
              </Card>
            )}

            {idmItems.length > 0 && (
              <Card>
                <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
                  <CardTitle className="text-base">IDM download list ({idmItems.length})</CardTitle>
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
                    Copy the URLs, then in IDM use Tasks → Add Batch Download From Clipboard. Or
                    grab the .ef2 file and use File → Import → From IDM export file.
                  </p>
                  <Textarea
                    readOnly
                    value={idmList}
                    rows={Math.min(idmItems.length + 1, 14)}
                    className="resize-y text-xs"
                    style={{ fontFamily: "var(--font-mono-stack)" }}
                  />
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
                <CardTitle className="text-base">
                  Collected links ({filteredItems.length})
                </CardTitle>
                {onlyFuckingfast && (
                  <Badge variant="secondary">FuckingFast only</Badge>
                )}
              </CardHeader>
              <CardContent className="grid gap-2">
                {filteredItems.map((i) => (
                  <div
                    key={`${i.host}-${i.kind}-${i.id}`}
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
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant="outline">{HOST_LABELS[i.host]}</Badge>
                      <Badge variant={i.tool === "wget" ? "default" : "secondary"}>{i.tool}</Badge>
                    </div>
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

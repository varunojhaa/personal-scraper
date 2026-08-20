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
import { Checkbox } from "@/components/ui/checkbox";
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
  isProtected,
  HOST_LABELS,
  type PixeldrainItem,
  type ScrapeResult,
} from "@/lib/pixeldrain-extract";

type ToolMode = "auto" | "wget" | "idm";

const keyOf = (i: PixeldrainItem) => `${i.host}:${i.kind}:${i.id}`;

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Personal Scraper — wget / IDM download builder" },
      {
        name: "description",
        content:
          "Personal Scraper — not a universal scraper. Collect download links by scrape, manual paste or .dlc container, then export a ready-to-run wget command or IDM batch list for the files you select.",
      },
      {
        property: "og:title",
        content: "Personal Scraper — wget / IDM download builder",
      },
      {
        property: "og:description",
        content:
          "Not a universal scraper. Collect links by scrape, manual paste or .dlc container, then export a wget command or IDM list for the files you select.",
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
  const [copied, setCopied] = useState(false);
  const [copiedIdm, setCopiedIdm] = useState(false);
  const [items, setItems] = useState<PixeldrainItem[]>([]);
  const [pending, setPending] = useState<PendingPage[]>([]);
  const [scannedCount, setScannedCount] = useState(0);
  const [activePaste, setActivePaste] = useState<string | null>(null);
  const [pasteValue, setPasteValue] = useState("");
  const [mode, setMode] = useState<ToolMode>("auto");
  const [includeOptional, setIncludeOptional] = useState(false);
  /** Unselected item keys — everything is selected unless it's in here. */
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const scrape = useServerFn(scrapePixeldrain);
  const resolvePaste = useServerFn(resolvePastedContent);
  const resolveDlc = useServerFn(resolveDlcContainer);

  const merge = (result: ScrapeResult) => {
    setItems((prev) => {
      const map = new Map(prev.map((i) => [keyOf(i), i]));
      for (const i of result.items) map.set(keyOf(i), i);
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
    mutationFn: (target: string) => scrape({ data: { url: target, deep: false } }),
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
        toast.error("No download links in that paste");
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
      // Only auto-select Pixeldrain links from a decrypted container; every
      // other host in the .dlc is deselected so the wget command targets just
      // the Pixeldrain files.
      setExcluded((prevEx) => {
        const next = new Set(prevEx);
        for (const i of d.items) if (i.host !== "pixeldrain") next.add(keyOf(i));
        return next;
      });
      if (d.items.length === 0) {
        toast.error(
          d.protectedPages.length
            ? "Container decrypted, but its links are captcha-protected — see the open-me queue"
            : "No download links in that container",
        );
        return;
      }
      const pd = d.items.filter((i) => i.host === "pixeldrain").length;
      toast.success(
        `Added ${d.items.length} link${d.items.length === 1 ? "" : "s"} — ${pd} Pixeldrain selected, ${
          d.items.length - pd
        } other host${d.items.length - pd === 1 ? "" : "s"} hidden`,
      );
    },
  });

  const quickWgetMutation = useMutation({
    mutationFn: (link: string) => resolvePaste({ data: { content: link, label: "quick" } }),
    onError: (e: Error) => toast.error(e.message || "Could not build the wget command"),
    onSuccess: (d) => {
      if (d.items.length === 0) {
        toast.error("No Pixeldrain link found in that input");
        return;
      }
      merge(d);
      const cmd = buildWget(d.items);
      void navigator.clipboard.writeText(cmd);
      toast.success("wget command copied to clipboard");
    },
  });

  /**
   * FuckingFast links only come from FitGirl repacks in this app, so any
   * FuckingFast item means we're in FitGirl mode: FuckingFast mirrors only,
   * IDM export, and the optional-content toggle becomes available.
   */
  const fitgirlMode = useMemo(() => items.some((i) => i.host === "fuckingfast"), [items]);

  /** A single Pixeldrain link present in the top URL input only. */
  const singlePdLink = useMemo(() => {
    const RX = /https?:\/\/(?:www\.)?pixeldrain\.com\/[ul]\/[A-Za-z0-9]+/gi;
    const t = url.trim();
    if (!t) return null;
    const matches = t.match(RX);
    return matches && matches.length === 1 ? matches[0] : null;
  }, [url]);

  const visibleItems = useMemo(() => {
    let out = fitgirlMode
      ? items.filter((i) => i.host === "fuckingfast" || i.host === "pixeldrain")
      : items;
    if (!includeOptional) out = out.filter((i) => !i.optional);
    return out;
  }, [items, fitgirlMode, includeOptional]);

  const selectedItems = useMemo(
    () => visibleItems.filter((i) => !excluded.has(keyOf(i))),
    [visibleItems, excluded],
  );

  const wgetItems = useMemo(
    () =>
      mode === "idm"
        ? []
        : mode === "wget"
          ? selectedItems
          : fitgirlMode
            ? []
            : selectedItems.filter((i) => i.tool === "wget"),
    [selectedItems, mode, fitgirlMode],
  );
  const idmItems = useMemo(
    () =>
      mode === "wget"
        ? []
        : mode === "idm"
          ? selectedItems
          : fitgirlMode
            ? selectedItems.filter((i) => i.tool === "idm")
            : [],
    [selectedItems, mode, fitgirlMode],
  );
  const command = useMemo(() => buildWget(wgetItems), [wgetItems]);
  const idmList = useMemo(() => buildIdmList(idmItems), [idmItems]);
  const openMe = pending.filter((p) => p.status === "open-me");

  const toggleItem = (k: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const selectAll = () => setExcluded(new Set());
  const selectNone = () => setExcluded(new Set(visibleItems.map(keyOf)));

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
    a.download = "downloads-idm.ef2";
    a.click();
    URL.revokeObjectURL(href);
    toast.success("Exported downloads-idm.ef2");
  };

  const downloadText = (content: string, filename: string, label: string) => {
    const blob = new Blob([content], { type: "text/plain" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(href);
    toast.success(`Exported ${label}`);
  };

  const submitPaste = (label: string) => {
    if (pasteValue.trim().length < 3) return;
    pasteMutation.mutate({ content: pasteValue, label });
  };

  const startScrape = () => {
    const target = url.trim();
    if (!target) return;
    if (isProtected(target)) {
      toast.error(
        "That host is captcha-protected — use the manual paste or .dlc upload below instead",
      );
      setPending((prev) =>
        prev.some((p) => p.url === target) ? prev : [...prev, { url: target, status: "open-me" }],
      );
      return;
    }
    scrapeMutation.mutate(target);
  };

  const resetAll = () => {
    setItems([]);
    setPending([]);
    setScannedCount(0);
    setActivePaste(null);
    setPasteValue("");
    setExcluded(new Set());
  };

  return (
    <main className="min-h-screen bg-background">
      <Toaster />
      <div className="border-b border-border" style={{ backgroundImage: "var(--gradient-hero)" }}>
        <div className="mx-auto max-w-4xl px-6 py-16">
          <Badge variant="outline" className="mb-4 gap-1.5">
            <Terminal className="h-3.5 w-3.5" /> personal
          </Badge>
          <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
            Personal Scraper
          </h1>
          <p className="mt-2 text-sm font-medium text-amber-300">
            Not a universal scraper — only the currently detected sources are supported:
            Pixeldrain links (from other sites) and FuckingFast mirrors (from fitgirl-repacks.site).
            Captcha hosts like filecrypt and viewcrate are never scraped directly; use a .dlc
            container or paste the link manually.
          </p>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Scan a page for direct links, or feed it a .dlc container / manual paste. Pick the files
            you want and copy one wget command (Pixeldrain) or an IDM batch list (FuckingFast).
          </p>

          <form
            className="mt-8 flex flex-col gap-3 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              startScrape();
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

          {singlePdLink && (
            <div className="mt-3 flex items-center gap-3">
              <p className="text-xs text-muted-foreground">
                Single Pixeldrain link detected — copy a ready wget command for it.
              </p>
              <Button
                size="sm"
                variant="secondary"
                disabled={quickWgetMutation.isPending}
                onClick={() => quickWgetMutation.mutate(singlePdLink)}
              >
                {quickWgetMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                Copy wget command
              </Button>
            </div>
          )}
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
                filecrypt / viewcrate style pages are never scraped. Open one, solve the captcha,
                then either download its .dlc container and upload it below, or paste the Pixeldrain
                link it reveals here.
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
              placeholder="Paste any Pixeldrain / FuckingFast links, a solved page URL, or raw HTML…"
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
              Drop a JDownloader <code>.dlc</code> container here. It gets decrypted and every link
              inside lands in the file picker below, but only the <strong>Pixeldrain</strong> links
              are ticked by default — other hosts stay deselected so you copy a pure Pixeldrain wget
              command. Tick the rest manually if you want them.
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
            No download links found on that page.
          </p>
        )}

        {items.length > 0 && (
          <div className="grid gap-6">
            <Card>
              <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
                <CardTitle className="text-base">Download tool</CardTitle>
                <div className="flex flex-wrap items-center gap-3">
                  {fitgirlMode && (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Switch checked={includeOptional} onCheckedChange={setIncludeOptional} />
                      Include optional content
                    </label>
                  )}
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
                  Auto sends Pixeldrain to wget and FuckingFast to IDM. Pick wget or IDM to force
                  everything into one list.
                  {fitgirlMode && " · FitGirl detected — FuckingFast mirrors only."}
                  {fitgirlMode && !includeOptional && " · optional content (bonus/selective files) is hidden."}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
                <CardTitle className="text-base">
                  Select files ({selectedItems.length}/{visibleItems.length})
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={selectAll}>
                    Select all
                  </Button>
                  <Button variant="ghost" size="sm" onClick={selectNone}>
                    Clear
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="grid gap-2">
                <div
                  className="grid gap-2 overflow-y-auto pr-1"
                  style={{ maxHeight: "calc(7 * 44px + 6 * 8px)" }}
                >
                {visibleItems.map((i) => {
                  const k = keyOf(i);
                  const checked = !excluded.has(k);
                  return (
                    <label
                      key={k}
                      className="flex cursor-pointer items-center gap-3 rounded-md border border-border bg-secondary/40 px-3 py-2"
                    >
                      <Checkbox checked={checked} onCheckedChange={() => toggleItem(k)} />
                      <span
                        className="min-w-0 flex-1 truncate text-sm"
                        style={{ fontFamily: "var(--font-mono-stack)" }}
                      >
                        {i.filename || i.pageUrl}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Badge variant="outline">{HOST_LABELS[i.host]}</Badge>
                        {i.optional && <Badge variant="secondary">optional</Badge>}
                        <Badge variant={i.tool === "wget" ? "default" : "secondary"}>
                          {i.tool}
                        </Badge>
                      </span>
                    </label>
                  );
                })}
                </div>
              </CardContent>
            </Card>

            {wgetItems.length > 0 && (
              <Card>
                <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
                  <CardTitle className="text-base">wget command ({wgetItems.length})</CardTitle>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => downloadText(command, "wget-command.txt", "wget-command.txt")}>
                      <FileDown className="h-4 w-4" /> .txt
                    </Button>
                    <Button variant="secondary" size="sm" onClick={copy}>
                      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Copy this command and paste it into a terminal — it downloads every selected
                    file in one line, with resume and correct filenames.
                  </p>
                  <Textarea
                    readOnly
                    value={command}
                    rows={3}
                    className="resize-y overflow-x-auto text-xs"
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
                    <Button variant="outline" size="sm" onClick={() => downloadText(idmList, "idm-urls.txt", "idm-urls.txt")}>
                      <FileDown className="h-4 w-4" /> .txt
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
          </div>
        )}
      </div>
    </main>
  );
}

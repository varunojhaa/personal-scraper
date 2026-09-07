import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
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
  Github,
  Upload,
  CloudDownload,
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
import { Progress } from "@/components/ui/progress";

import {
  scrapePixeldrain,
  resolvePastedContent,
  resolveDlcContainer,
  resolveFileKeeperIdmLinks,
} from "@/lib/scrape.functions";

import {
  extract,
  buildWget,
  buildShellScript,
  buildIdmList,
  buildFileKeeperIdmScript,
  isIdmReady,
  exportName,
  isProtected,
  isFileHostUrl,
  validateManualInput,
  HOST_LABELS,
  UA,
  type PixeldrainItem,
  type ScrapeResult,
} from "@/lib/pixeldrain-extract";

type ToolMode = "auto" | "wget" | "idm";

type DlcHost = "pixeldrain" | "fileditch" | "filekeeper";

type PendingPage = {
  url: string;
  status: "open-me" | "resolved";
};

type PasteVariables = {
  content: string;
  label: string;
  replace: boolean;
};

type DlcVariables = {
  file: File;
  host: DlcHost;
};

type StatusMessage = {
  text: string;
  kind: "working" | "success" | "error" | "info";
};

type ResolvedIdmLink = {
  url: string;
  referer: string;
  cookie: string;
};

const DLC_HOSTS: DlcHost[] = ["pixeldrain", "fileditch", "filekeeper"];

const TOOL_MODES: ToolMode[] = ["auto", "wget", "idm"];

/** Ignore filename fragments when identifying an existing file. */
const keyOf = (item: PixeldrainItem): string =>
  `${item.host}:${item.kind}:${item.id.split("#")[0]}`;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function normalizeItem(item: PixeldrainItem): PixeldrainItem {
  if (item.host !== "filekeeper") {
    return item;
  }

  // Older server responses may incorrectly use the file code or signed
  // URL token as the filename. Let wget use Content-Disposition instead.
  let filename = item.filename;

  try {
    const parsed = new URL(item.pageUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const hostname = parsed.hostname.toLowerCase();

    const isFileKeeper = hostname === "filekeeper.net" || hostname.endsWith(".filekeeper.net");

    const isTunnel = hostname === "dlproxy.uk" || hostname.endsWith(".dlproxy.uk");

    const last = parts[parts.length - 1] ?? "";

    if (
      filename &&
      ((isFileKeeper && parts.length === 1 && filename === last) ||
        (isTunnel && (filename === last || filename === item.id)))
    ) {
      filename = undefined;
    }
  } catch {
    // Keep available metadata if the URL cannot be parsed.
  }

  const normalized: PixeldrainItem = {
    ...item,
    tool: "wget",
  };

  // With exactOptionalPropertyTypes, absent values must be omitted.
  if (filename !== undefined) {
    normalized.filename = filename;
  } else {
    delete normalized.filename;
  }

  return normalized;
}

function mergeItems(previous: PixeldrainItem[], incoming: PixeldrainItem[]): PixeldrainItem[] {
  const map = new Map<string, PixeldrainItem>();

  for (const raw of previous) {
    const item = normalizeItem(raw);
    map.set(keyOf(item), item);
  }

  for (const raw of incoming) {
    const item = normalizeItem(raw);
    const key = keyOf(item);
    const existing = map.get(key);

    const filename = item.filename || existing?.filename;
    const optional = item.optional ?? existing?.optional;

    const merged: PixeldrainItem = {
      ...existing,
      ...item,
    };

    if (filename !== undefined) {
      merged.filename = filename;
    } else {
      delete merged.filename;
    }

    // Preserve false; only undefined means the property is absent.
    if (optional !== undefined) {
      merged.optional = optional;
    } else {
      delete merged.optional;
    }

    map.set(key, merged);
  }

  return [...map.values()];
}

function mergePending(previous: PendingPage[], urls: string[]): PendingPage[] {
  const map = new Map(previous.map((page) => [page.url, page] as const));

  for (const url of urls) {
    if (!map.has(url)) {
      map.set(url, { url, status: "open-me" });
    }
  }

  return [...map.values()];
}

/**
 * Do not fetch FileKeeper pages or signed tunnel URLs just to create
 * downloader items. The generated Python/wget command resolves them
 * locally when the user actually starts the download.
 */
function localFileKeeperResult(content: string, label: string): ScrapeResult | null {
  const found = new Map<string, PixeldrainItem>();
  extract(content, label, found);

  const items = [...found.values()];

  if (items.length === 0 || items.some((item) => item.host !== "filekeeper")) {
    return null;
  }

  return {
    sourceUrl: label,
    items: items.map(normalizeItem),
    pagesScanned: [],
    protectedPages: [],
    scrapedAt: new Date().toISOString(),
  };
}

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      {
        title: "Personal Scraper — wget / IDM download builder",
      },
      {
        name: "description",
        content:
          "Collect supported download links from pages, manual paste, or .dlc containers, then export wget commands or IDM download lists.",
      },
      {
        property: "og:title",
        content: "Personal Scraper — wget / IDM download builder",
      },
      {
        property: "og:description",
        content:
          "Collect supported download links and export wget commands or IDM lists for the files you select.",
      },
      {
        property: "og:type",
        content: "website",
      },
      {
        name: "twitter:card",
        content: "summary_large_image",
      },
    ],
  }),
  component: Index,
});

function isFitgirlSource(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "fitgirl-repacks.site" || host.endsWith(".fitgirl-repacks.site");
  } catch {
    return false;
  }
}

function buildResolvedIdmExport(links: ResolvedIdmLink[]): string {
  return links.map((link) => link.url).join("\n");
}

function Index() {
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [copiedIdm, setCopiedIdm] = useState(false);

  const [items, setItems] = useState<PixeldrainItem[]>([]);
  const [pending, setPending] = useState<PendingPage[]>([]);
  const [scannedPages, setScannedPages] = useState<Set<string>>(() => new Set<string>());

  const [activePaste, setActivePaste] = useState<string | null>(null);
  const [pasteValue, setPasteValue] = useState("");

  const [mode, setMode] = useState<ToolMode>("auto");
  const [includeOptional, setIncludeOptional] = useState(false);

  /** Everything is selected unless its key appears here. */
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set<string>());

  const [dlcHost, setDlcHost] = useState<DlcHost>("pixeldrain");
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [clearance, setClearance] = useState("");
  const [cloudflareProgress, setCloudflareProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idmCopyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current) {
        clearTimeout(copyTimer.current);
      }

      if (idmCopyTimer.current) {
        clearTimeout(idmCopyTimer.current);
      }
    };
  }, []);

  const scrape = useServerFn(scrapePixeldrain);
  const resolvePaste = useServerFn(resolvePastedContent);
  const resolveDlc = useServerFn(resolveDlcContainer);
  const resolveFileKeeper = useServerFn(resolveFileKeeperIdmLinks);

  const resolveFileKeeperMutation = useMutation({
    mutationFn: async (selected: PixeldrainItem[]) => {
      const links: ResolvedIdmLink[] = [];
      const failed: string[] = [];
      for (let start = 0; start < selected.length; start += 100) {
        const batch = selected.slice(start, start + 100);
        try {
          const result = await resolveFileKeeper({
            data: {
              items: batch.map((item) => ({
                pageUrl: item.pageUrl,
                ...(item.filename ? { filename: item.filename } : {}),
              })),
            },
          });
          links.push(...result.links);
          failed.push(
            ...result.failed.map((message) => `Batch ${Math.floor(start / 100) + 1}: ${message}`),
          );
        } catch (error) {
          failed.push(
            `Batch ${Math.floor(start / 100) + 1}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        setCloudflareProgress({
          done: Math.min(start + batch.length, selected.length),
          total: selected.length,
        });
      }
      return { links, resolved: links.length, failed };
    },
    onMutate: (selected) => {
      setCloudflareProgress({ done: 0, total: selected.length });
      setStatus({ kind: "working", text: "Resolving FileKeeper links on Cloudflare…" });
    },
    onError: (error) => {
      setCloudflareProgress(null);
      reportError(error, "Cloudflare FileKeeper resolution failed");
    },
    onSuccess: ({ links, resolved, failed }) => {
      setCloudflareProgress(null);
      downloadText(buildResolvedIdmExport(links), "filekeeper-cloudflare-idm-urls.txt");
      const text = `Created an IDM URL list for ${resolved} file(s).${failed.length ? ` ${failed.length} failed.` : ""}`;
      setStatus({ kind: failed.length ? "info" : "success", text });
      if (failed.length) toast.warning(failed.join(" "));
      else toast.success(text);
    },
  });

  async function resolveInput(content: string, label: string): Promise<ScrapeResult> {
    const local = localFileKeeperResult(content, label);

    if (local) {
      return local;
    }

    return resolvePaste({
      data: { content, label },
    });
  }

  function applyResult(result: ScrapeResult, replace: boolean, selectedHost?: DlcHost) {
    const incoming = result.items.map(normalizeItem);

    setItems((previous) => mergeItems(replace ? [] : previous, incoming));

    setScannedPages((previous) => {
      const next = replace ? new Set<string>() : new Set(previous);

      for (const page of result.pagesScanned) {
        next.add(page);
      }

      return next;
    });

    setPending((previous) => mergePending(replace ? [] : previous, result.protectedPages));

    if (replace) {
      setExcluded(
        new Set(
          selectedHost ? incoming.filter((item) => item.host !== selectedHost).map(keyOf) : [],
        ),
      );

      setCopied(false);
      setCopiedIdm(false);
    }
  }

  function reportError(error: unknown, fallback: string) {
    const text = errorMessage(error, fallback);
    setStatus({ kind: "error", text });
    toast.error(text);
  }

  const scrapeMutation = useMutation({
    mutationFn: (target: string) =>
      scrape({
        data: {
          url: target,
          deep: false,
        },
      }),

    onMutate: (target) => {
      setStatus({
        kind: "working",
        text: `Fetching ${target} and scanning for download links…`,
      });
    },

    onError: (error) => {
      reportError(error, "Scrape failed");
    },

    onSuccess: (result) => {
      const fitgirl = isFitgirlSource(result.sourceUrl);
      applyResult(result, false, fitgirl ? "filekeeper" : undefined);
      if (fitgirl) {
        setDlcHost("filekeeper");
        setMode("idm");
        setExcluded((previous) => {
          const next = new Set(previous);
          for (const item of result.items) {
            if (item.host !== "filekeeper") next.add(keyOf(item));
          }
          return next;
        });
      }

      const text =
        `Scanned ${result.pagesScanned.length} page(s), ` +
        `found ${result.items.length} link(s).` +
        (result.protectedPages.length
          ? ` ${result.protectedPages.length} page(s) need browser verification.`
          : "");

      setStatus({
        kind: result.items.length ? "success" : "info",
        text,
      });

      if (result.items.length) {
        toast.success(text);
      } else {
        toast.info(text);
      }
    },
  });

  const pasteMutation = useMutation({
    mutationFn: (variables: PasteVariables) => resolveInput(variables.content, variables.label),

    onMutate: () => {
      setStatus({
        kind: "working",
        text: "Reading links and resolving available filenames…",
      });
    },

    onError: (error) => {
      reportError(error, "Could not read pasted content");
    },

    onSuccess: (result, variables) => {
      // An empty paste must not destroy a working session.
      if (!result.items.length) {
        if (result.protectedPages.length) {
          applyResult(result, false);
        }

        setStatus({
          kind: "info",
          text: "No supported download links were found. Existing files were kept.",
        });
        toast.error("No supported download links in that input");
        return;
      }

      applyResult(result, variables.replace);

      if (!variables.replace) {
        setPending((previous) =>
          previous.map((page) =>
            page.url === variables.label ? { ...page, status: "resolved" } : page,
          ),
        );
      }

      setActivePaste(null);
      setPasteValue("");

      const fileKeeperOnly = result.items.every((item) => item.host === "filekeeper");

      const text =
        `Added ${result.items.length} link(s).` +
        (fileKeeperOnly ? " FileKeeper download URLs will be resolved when the command runs." : "");

      setStatus({ kind: "success", text });
      toast.success(`Added ${result.items.length} link(s)`);
    },
  });

  const dlcMutation = useMutation({
    mutationFn: async ({ file, host }: DlcVariables) => {
      const base64 = (await file.text()).trim();

      if (!base64) {
        throw new Error("That container is empty.");
      }

      // Capture the chosen host in mutation variables so changing UI
      // state cannot alter how the completed request is selected.
      return resolveDlc({
        data: {
          base64,
          filename: file.name,

          // FileKeeper pages should not be fetched to create items.
          // Its generated downloader handles the free-download flow.
          follow: host !== "filekeeper",
          hostFilter: host,
        },
      });
    },

    onMutate: ({ file, host }) => {
      setStatus({
        kind: "working",
        text: `Decrypting ${file.name} and collecting ` + `${HOST_LABELS[host]} links…`,
      });
    },

    onError: (error) => {
      reportError(error, "Could not read that container");
    },

    onSuccess: (result, { host }) => {
      if (!result.items.length) {
        if (result.protectedPages.length) {
          applyResult(result, false);
        }

        const text = result.protectedPages.length
          ? "Container decrypted, but its links need browser verification. See the open-me queue."
          : "No supported links were returned from the container. Existing files were kept.";

        setStatus({ kind: "info", text });
        toast.info(text);
        return;
      }

      applyResult(result, true, host);
      setActivePaste(null);
      setPasteValue("");

      const hostCount = result.items.filter((item) => item.host === host).length;

      const text =
        `Added ${result.items.length} link(s); ` +
        `${hostCount} ${HOST_LABELS[host]} link(s) enabled for selection. ` +
        "Optional-file filtering still applies.";

      setStatus({ kind: "success", text });
      toast.success(`Added ${result.items.length} container link(s)`);
    },
  });

  const quickWgetMutation = useMutation({
    mutationFn: (link: string) => resolveInput(link, link),

    onMutate: () => {
      setStatus({
        kind: "working",
        text: "Preparing the download command…",
      });
    },

    onError: (error) => {
      reportError(error, "Could not build the wget command");
    },

    onSuccess: async (result) => {
      const downloadable = result.items.map(normalizeItem).filter((item) => item.tool === "wget");

      if (!downloadable.length) {
        setStatus({
          kind: "info",
          text: "No supported wget links were found.",
        });
        toast.error("No supported wget links were found");
        return;
      }

      applyResult(result, false);

      try {
        await navigator.clipboard.writeText(buildWget(downloadable, clearance));

        setStatus({
          kind: "success",
          text: "wget command copied to your clipboard.",
        });
        toast.success("wget command copied");
      } catch {
        setStatus({
          kind: "info",
          text: "Links were added, but clipboard access failed. Use the command box or download.sh export below.",
        });
        toast.error("Clipboard access failed. Use the command box or export below.");
      }
    },
  });

  const busy =
    scrapeMutation.isPending ||
    pasteMutation.isPending ||
    dlcMutation.isPending ||
    quickWgetMutation.isPending ||
    resolveFileKeeperMutation.isPending;

  /**
   * Only show quick wget for one complete supported URL whose extracted
   * item actually recommends wget. Includes FileKeeper and tunnel URLs.
   */
  const singleWgetLink = useMemo(() => {
    const target = url.trim();

    if (!target || /\s/.test(target)) {
      return null;
    }

    try {
      const parsed = new URL(target);

      if (!["http:", "https:"].includes(parsed.protocol)) {
        return null;
      }
    } catch {
      return null;
    }

    if (!isFileHostUrl(target)) {
      return null;
    }

    const found = new Map<string, PixeldrainItem>();
    extract(target, target, found);

    const entries = [...found.values()];

    if (entries.length !== 1) {
      return null;
    }

    const first = entries[0];

    if (!first) {
      return null;
    }

    const item = normalizeItem(first);

    if (item.tool !== "wget") {
      return null;
    }

    return {
      url: target,
      label: HOST_LABELS[item.host],
    };
  }, [url]);

  const hasOptional = useMemo(() => items.some((item) => item.optional), [items]);

  const visibleItems = useMemo(
    () => (includeOptional ? items : items.filter((item) => !item.optional)),
    [items, includeOptional],
  );

  const selectedItems = useMemo(
    () => visibleItems.filter((item) => !excluded.has(keyOf(item))),
    [visibleItems, excluded],
  );

  const wgetItems = useMemo(
    () =>
      mode === "idm"
        ? []
        : mode === "wget"
          ? selectedItems
          : selectedItems.filter((item) => item.tool === "wget"),
    [selectedItems, mode],
  );

  const idmItems = useMemo(
    () =>
      mode === "wget"
        ? []
        : mode === "idm"
          ? selectedItems
          : selectedItems.filter((item) => item.tool === "idm"),
    [selectedItems, mode],
  );

  const hasFileDitch = wgetItems.some((item) => item.host === "fileditch");

  const hasFileKeeper = wgetItems.some((item) => item.host === "filekeeper");

  const forcedPageHosts = wgetItems.some((item) => item.tool === "idm");

  const idmHasFileKeeper = idmItems.some((item) => item.host === "filekeeper");

  const cloudflareFileKeeperItems = useMemo(
    () =>
      idmItems.filter((item) => {
        try {
          const host = new URL(item.pageUrl).hostname.toLowerCase();
          return host === "filekeeper.net" || host.endsWith(".filekeeper.net");
        } catch {
          return false;
        }
      }),
    [idmItems],
  );

  const command = useMemo(() => buildWget(wgetItems, clearance), [wgetItems, clearance]);

  const idmList = useMemo(() => buildIdmList(idmItems), [idmItems]);
  const idmExport = idmList;

  const idmReadyCount = useMemo(
    () => idmItems.filter((item) => isIdmReady(item)).length,
    [idmItems],
  );

  const openMe = pending.filter((page) => page.status === "open-me");

  const scannedCount = scannedPages.size;

  useEffect(() => {
    setCopied(false);
  }, [command]);

  useEffect(() => {
    setCopiedIdm(false);
  }, [idmList]);

  function toggleItem(key: string) {
    setExcluded((previous) => {
      const next = new Set(previous);

      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }

      return next;
    });
  }

  function selectAll() {
    setExcluded((previous) => {
      const next = new Set(previous);

      for (const item of visibleItems) {
        next.delete(keyOf(item));
      }

      return next;
    });
  }

  function selectNone() {
    setExcluded((previous) => {
      const next = new Set(previous);

      for (const item of visibleItems) {
        next.add(keyOf(item));
      }

      return next;
    });
  }

  async function copyCommand() {
    if (!command) {
      return;
    }

    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      toast.success("Command copied");

      if (copyTimer.current) {
        clearTimeout(copyTimer.current);
      }

      copyTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Clipboard access failed. Select the command manually or export it.");
    }
  }

  async function copyIdm() {
    if (!idmList) {
      return;
    }

    try {
      await navigator.clipboard.writeText(idmList);
      setCopiedIdm(true);
      toast.success("URLs copied — paste into IDM batch download");

      if (idmCopyTimer.current) {
        clearTimeout(idmCopyTimer.current);
      }

      idmCopyTimer.current = setTimeout(() => setCopiedIdm(false), 1600);
    } catch {
      toast.error("Clipboard access failed. Select the URLs manually or export them.");
    }
  }

  function downloadText(content: string, filename: string) {
    if (!content) {
      toast.error("There is nothing to export.");
      return;
    }

    let href: string | undefined;
    const anchor = document.createElement("a");

    try {
      const windowsContent = content.replace(/\r?\n/g, "\r\n");
      const blob = new Blob([windowsContent], {
        type: "text/plain;charset=utf-8",
      });

      href = URL.createObjectURL(blob);
      anchor.href = href;
      anchor.download = filename;

      document.body.appendChild(anchor);
      anchor.click();

      toast.success(`Exported ${filename}`);
    } catch (error) {
      toast.error(errorMessage(error, "Export failed"));
    } finally {
      anchor.remove();

      if (href) {
        const objectUrl = href;
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }
    }
  }

  function submitPaste(label: string, replace: boolean) {
    if (busy) {
      return;
    }

    const problem = validateManualInput(pasteValue);

    if (problem) {
      setStatus({
        kind: "error",
        text: problem,
      });
      toast.error(problem);
      return;
    }

    pasteMutation.mutate({
      content: pasteValue.trim(),
      label,
      replace,
    });
  }

  function startScrape() {
    if (busy) {
      return;
    }

    const target = url.trim();

    if (!target) {
      toast.error("Paste a page or file URL first.");
      return;
    }

    try {
      const parsed = new URL(target);

      if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || /\s/.test(target)) {
        throw new Error("Invalid URL");
      }
    } catch {
      toast.error(
        /^https?:\/\//i.test(target)
          ? "That doesn't look like a complete web address."
          : "Paste a full address starting with https://.",
      );
      return;
    }

    if (isProtected(target)) {
      setPending((previous) => mergePending(previous, [target]));

      setStatus({
        kind: "info",
        text: "Protected page queued below. Open it, complete verification, then paste the revealed links.",
      });

      toast.info("Open the protected page using the queue below");
      return;
    }

    if (isFileHostUrl(target)) {
      pasteMutation.mutate({
        content: target,
        label: target,
        replace: true,
      });
      return;
    }

    scrapeMutation.mutate(target);
  }

  function resetAll() {
    if (busy) {
      return;
    }

    setUrl("");
    setItems([]);
    setPending([]);
    setScannedPages(new Set<string>());
    setActivePaste(null);
    setPasteValue("");
    setExcluded(new Set<string>());
    setStatus(null);
    setClearance("");
    setCopied(false);
    setCopiedIdm(false);
    setIncludeOptional(false);
    setMode("auto");

    if (copyTimer.current) {
      clearTimeout(copyTimer.current);
    }

    if (idmCopyTimer.current) {
      clearTimeout(idmCopyTimer.current);
    }

    scrapeMutation.reset();
    pasteMutation.reset();
    dlcMutation.reset();
    quickWgetMutation.reset();
  }

  return (
    <main className="min-h-screen bg-background">
      <Toaster />

      <div
        className="border-b border-border"
        style={{
          backgroundImage: "var(--gradient-hero)",
        }}
      >
        <div className="mx-auto max-w-4xl px-6 py-16">
          <div className="mb-4 flex items-center gap-2">
            <Badge variant="outline" className="gap-1.5">
              <Terminal className="h-3.5 w-3.5" />
              personal
            </Badge>

            <Button variant="outline" size="sm" asChild>
              <a
                href="https://github.com/varunojhaa/personal-scraper"
                target="_blank"
                rel="noopener noreferrer"
                className="gap-1.5"
              >
                <Github className="h-3.5 w-3.5" />
                GitHub
              </a>
            </Button>
          </div>

          <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
            Personal Scraper
          </h1>

          <p className="mt-2 text-sm font-medium text-amber-300">
            Not a universal scraper. Supported download hosts:{" "}
            {Object.values(HOST_LABELS).join(", ")}. Captcha-protected pages must be opened in your
            browser.
          </p>

          <p className="mt-3 max-w-2xl text-muted-foreground">
            Scan a page, paste supported links, or upload a .dlc container. Select files and export
            a wget command or IDM download list.
          </p>

          <form
            className="mt-8 flex flex-col gap-3 rounded-2xl border-2 border-primary/50 bg-card/60 p-3 shadow-[var(--shadow-glow)] backdrop-blur sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              startScrape();
            }}
          >
            <div className="relative flex-1">
              <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />

              <Input
                type="url"
                required
                aria-label="Page or download URL"
                value={url}
                disabled={busy}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="Paste link"
                className="h-12 border-primary/40 pl-9 text-base ring-primary/30"
              />
            </div>

            <Button
              type="submit"
              size="lg"
              disabled={busy}
              className="h-12 px-7 text-base shadow-[var(--shadow-glow)]"
            >
              {busy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Working
                </>
              ) : (
                <>
                  <Download className="h-4 w-4" />
                  Collect links
                </>
              )}
            </Button>
          </form>

          {singleWgetLink && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p className="text-xs text-muted-foreground">
                Single {singleWgetLink.label} link detected.
              </p>

              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => quickWgetMutation.mutate(singleWgetLink.url)}
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

          {(busy || status) && (
            <div
              className="mt-4 rounded-xl border border-primary/40 bg-card/70 p-4 backdrop-blur"
              role="status"
              aria-live="polite"
            >
              <div className="flex items-center gap-2 text-sm">
                {busy ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                ) : status?.kind === "error" ? (
                  <ShieldAlert className="h-4 w-4 shrink-0 text-destructive" />
                ) : status?.kind === "success" ? (
                  <Check className="h-4 w-4 shrink-0 text-primary" />
                ) : (
                  <Link2 className="h-4 w-4 shrink-0 text-primary" />
                )}

                <span className="break-words text-foreground">{status?.text ?? "Working…"}</span>
              </div>

              {busy && (
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary">
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
                </div>
              )}

              {items.length > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {items.length} link(s) collected · {scannedCount} unique page(s) scanned
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mx-auto max-w-4xl px-6 py-12">
        {(items.length > 0 || pending.length > 0) && (
          <div className="mb-6 flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              {scannedCount} page(s) scanned · {items.length} link(s) collected
            </span>

            <Button variant="ghost" size="sm" disabled={busy} onClick={resetAll}>
              <Trash2 className="h-3.5 w-3.5" />
              Clear session
            </Button>
          </div>
        )}

        {pending.length > 0 && (
          <Card className="mb-6 border-destructive/40">
            <CardHeader className="flex-row items-center gap-2 space-y-0">
              <ShieldAlert className="h-4 w-4 text-destructive" />
              <CardTitle className="text-base">
                Open me — protected pages ({openMe.length} left)
              </CardTitle>
            </CardHeader>

            <CardContent className="grid gap-3">
              <p className="text-sm text-muted-foreground">
                Open a page and complete its verification. Then upload its .dlc container or paste
                the supported download links it reveals. Pasting a result here adds to your current
                session.
              </p>

              {pending.map((page) => (
                <div key={page.url} className="rounded-md border border-border bg-secondary/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span
                      title={page.url}
                      className="min-w-0 flex-1 truncate text-sm"
                      style={{
                        fontFamily: "var(--font-mono-stack)",
                      }}
                    >
                      {page.url}
                    </span>

                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={page.status === "resolved" ? "default" : "secondary"}>
                        {page.status === "resolved" ? "resolved" : "open me"}
                      </Badge>

                      <Button variant="outline" size="sm" asChild>
                        <a href={page.url} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="h-3.5 w-3.5" />
                          Open
                        </a>
                      </Button>

                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setActivePaste(activePaste === page.url ? null : page.url);
                          setPasteValue("");
                        }}
                      >
                        <ClipboardPaste className="h-3.5 w-3.5" />
                        Paste result
                      </Button>
                    </div>
                  </div>

                  {activePaste === page.url && (
                    <div className="mt-3 grid gap-2">
                      <Textarea
                        autoFocus
                        rows={4}
                        disabled={busy}
                        aria-label="Revealed download links"
                        value={pasteValue}
                        onChange={(event) => setPasteValue(event.target.value)}
                        placeholder="Paste revealed download links or page HTML…"
                        className="text-xs"
                        style={{
                          fontFamily: "var(--font-mono-stack)",
                        }}
                      />

                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setActivePaste(null)}
                        >
                          Cancel
                        </Button>

                        <Button
                          size="sm"
                          disabled={busy || !pasteValue.trim()}
                          onClick={() => submitPaste(page.url, false)}
                        >
                          {pasteMutation.isPending ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Check className="h-3.5 w-3.5" />
                          )}
                          Add links
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

          <CardContent className="grid gap-3">
            <p className="text-xs text-muted-foreground">
              Paste supported links or HTML. A successful manual import replaces the current file
              list.
            </p>

            <Textarea
              rows={4}
              disabled={busy}
              aria-label="Manual download links or HTML"
              value={activePaste === "__manual__" ? pasteValue : ""}
              onFocus={() => {
                if (activePaste !== "__manual__") {
                  setActivePaste("__manual__");
                  setPasteValue("");
                }
              }}
              onChange={(event) => {
                setActivePaste("__manual__");
                setPasteValue(event.target.value);
              }}
              placeholder="Paste Pixeldrain, FileDitch, FileKeeper, or DataNodes links…"
              className="text-xs"
              style={{
                fontFamily: "var(--font-mono-stack)",
              }}
            />

            <p className="text-xs text-muted-foreground">
              FileKeeper: prefer the original filekeeper.net URL. Fresh tunnel*.dlproxy.uk/download/
              links are also accepted, but signed links can expire.
            </p>

            <div className="flex justify-end">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || activePaste !== "__manual__" || !pasteValue.trim()}
                onClick={() => submitPaste("manual paste", true)}
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
              Choose a JDownloader <code>.dlc</code> container. A successful import replaces the
              current list and enables returned <strong>{HOST_LABELS[dlcHost]}</strong> links for
              selection. Other returned hosts remain deselected.
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Preferred host:</span>

              <div className="flex flex-wrap items-center gap-1 rounded-md border border-border p-1">
                {DLC_HOSTS.map((host) => (
                  <Button
                    key={host}
                    type="button"
                    size="sm"
                    disabled={busy}
                    variant={dlcHost === host ? "default" : "ghost"}
                    className="h-7 px-3 text-xs"
                    onClick={() => setDlcHost(host)}
                  >
                    {HOST_LABELS[host]}
                  </Button>
                ))}
              </div>
            </div>

            {dlcHost === "filekeeper" && (
              <p className="text-xs text-muted-foreground">
                FileKeeper page-following is disabled during container import. Direct FileKeeper
                links are resolved by the generated download command. Protected wrapper links may
                still need manual opening.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <label
                htmlFor="dlc-file"
                className={
                  "inline-flex h-11 items-center gap-2 rounded-md border border-primary/60 bg-primary/10 px-4 text-sm font-medium text-primary transition-colors " +
                  (busy ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-primary/20")
                }
              >
                <Upload className="h-4 w-4" />
                Choose .dlc file
              </label>

              <input
                id="dlc-file"
                type="file"
                accept=".dlc,.txt"
                className="sr-only"
                disabled={busy}
                onClick={(event) => {
                  event.currentTarget.value = "";
                }}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];

                  if (!file || busy) {
                    return;
                  }

                  dlcMutation.mutate({
                    file,
                    host: dlcHost,
                  });
                }}
              />

              {dlcMutation.isPending && (
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Decrypting container…
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {items.length > 0 && (
          <div className="grid gap-6">
            <Card>
              <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
                <CardTitle className="text-base">Download tool</CardTitle>

                <div className="flex flex-wrap items-center gap-3">
                  {hasOptional && (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Switch checked={includeOptional} onCheckedChange={setIncludeOptional} />
                      Include optional/selective files
                    </label>
                  )}

                  <div className="flex items-center gap-1 rounded-md border border-border p-1">
                    {TOOL_MODES.map((toolMode) => (
                      <Button
                        key={toolMode}
                        size="sm"
                        variant={mode === toolMode ? "default" : "ghost"}
                        onClick={() => setMode(toolMode)}
                      >
                        {toolMode === "auto" ? "Auto" : toolMode === "wget" ? "wget" : "IDM"}
                      </Button>
                    ))}
                  </div>
                </div>
              </CardHeader>

              <CardContent className="grid gap-2">
                <p className="text-xs text-muted-foreground">
                  Auto sends Pixeldrain, FileDitch, and FileKeeper to wget; DataNodes to IDM. No
                  supported host is hidden just because another host is present.
                </p>

                {hasOptional && !includeOptional && (
                  <p className="text-xs text-amber-500">
                    Optional/selective files are hidden. Check the source instructions: some
                    installations require at least one selective language pack.
                  </p>
                )}

                {forcedPageHosts && (
                  <p className="text-xs text-amber-500">
                    Forcing DataNodes into wget may save an HTML page instead of the file. Use Auto
                    or IDM unless you have a real direct download URL.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
                <CardTitle className="text-base">
                  Select files ({selectedItems.length}/{visibleItems.length})
                </CardTitle>

                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!visibleItems.length}
                    onClick={selectAll}
                  >
                    Select all
                  </Button>

                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!visibleItems.length}
                    onClick={selectNone}
                  >
                    Clear selection
                  </Button>
                </div>
              </CardHeader>

              <CardContent className="grid gap-2">
                {visibleItems.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    All files are hidden by the optional/selective filter. Enable the toggle above
                    to show them.
                  </p>
                ) : (
                  <div
                    className="grid gap-2 overflow-y-auto pr-1"
                    style={{
                      maxHeight: "calc(7 * 52px + 6 * 8px)",
                    }}
                  >
                    {visibleItems.map((item) => {
                      const key = keyOf(item);
                      const checked = !excluded.has(key);
                      const effectiveTool = mode === "auto" ? item.tool : mode;

                      return (
                        <label
                          key={key}
                          className="flex cursor-pointer items-center gap-3 rounded-md border border-border bg-secondary/40 px-3 py-2"
                        >
                          <Checkbox
                            checked={checked}
                            aria-label={`Select ${item.filename || item.pageUrl}`}
                            onCheckedChange={() => toggleItem(key)}
                          />

                          <span
                            title={item.filename || item.pageUrl}
                            className="min-w-0 flex-1 truncate text-sm"
                            style={{
                              fontFamily: "var(--font-mono-stack)",
                            }}
                          >
                            {item.filename || item.pageUrl}
                          </span>

                          <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                            <Badge variant="outline">{HOST_LABELS[item.host]}</Badge>

                            {item.optional && <Badge variant="secondary">optional</Badge>}

                            <Badge variant={effectiveTool === "wget" ? "default" : "secondary"}>
                              {effectiveTool}
                            </Badge>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}

                {visibleItems.length > 0 && selectedItems.length === 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Select at least one file to generate an export.
                  </p>
                )}
              </CardContent>
            </Card>

            {wgetItems.length > 0 && (
              <Card>
                <CardHeader className="flex-row flex-wrap items-center justify-between gap-4 space-y-0">
                  <CardTitle className="text-base">wget command ({wgetItems.length})</CardTitle>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        downloadText(
                          buildShellScript(wgetItems, clearance),
                          exportName(wgetItems, url, "sh"),
                        )
                      }
                    >
                      <FileDown className="h-4 w-4" />
                      download.sh
                    </Button>

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => downloadText(command, exportName(wgetItems, url, "txt"))}
                    >
                      <FileDown className="h-4 w-4" />
                      .txt
                    </Button>

                    <Button variant="secondary" size="sm" onClick={copyCommand}>
                      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                </CardHeader>

                <CardContent className="grid gap-3">
                  {hasFileKeeper && (
                    <div className="rounded-md border border-primary/40 bg-primary/5 p-3">
                      <p className="text-xs text-muted-foreground">
                        <strong className="text-foreground">FileKeeper downloads.</strong> The
                        generated command uses Python 3 to submit the free-download form, retain
                        cookies, wait for an advertised countdown, and pass the signed tunnel URL to
                        wget.
                      </p>

                      <p className="mt-2 text-xs text-muted-foreground">
                        Prefer the original filekeeper.net link. Pasted tunnel URLs can expire or be
                        single-use. If the page requires a captcha or unsupported JavaScript, open
                        it in your browser and copy a fresh download URL.
                      </p>

                      <p className="mt-2 text-xs text-muted-foreground">
                        If a filename is unknown, wget uses the server&apos;s Content-Disposition
                        header. Those items do not receive filename-based .done markers.
                      </p>
                    </div>
                  )}

                  {hasFileDitch && (
                    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                      <p className="mb-2 text-xs text-muted-foreground">
                        <strong className="text-foreground">FileDitch browser pass.</strong> If
                        requested by the downloader, paste your own FileDitch{" "}
                        <code>cf_clearance</code> cookie. It may expire or be tied to your browser
                        and IP address.
                      </p>

                      <Input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        aria-label="FileDitch cf_clearance cookie"
                        value={clearance}
                        onChange={(event) => setClearance(event.target.value)}
                        placeholder="cf_clearance value (optional)"
                        className="h-9 text-xs"
                        style={{
                          fontFamily: "var(--font-mono-stack)",
                        }}
                      />

                      <p className="mt-2 text-xs text-amber-500">
                        This field is kept in page memory and is not sent to the scraper server.
                        However, its value is embedded in copied commands and exported scripts and
                        may appear in shell history or process arguments. Do not share those
                        exports. Clear session removes the value from this page.
                      </p>
                    </div>
                  )}

                  <p className="text-xs text-muted-foreground">
                    Paste the command into Bash on Linux/WSL with wget, setsid, and nohup installed.
                    FileKeeper and FileDitch also require Python 3. Downloads run in the background;
                    monitor them with <code>tail -f wget.log</code>.
                  </p>

                  <p className="text-xs text-muted-foreground">
                    The .sh export runs in the foreground when launched with{" "}
                    <code>bash filename.sh</code>.
                  </p>

                  <Textarea
                    readOnly
                    aria-label="Generated wget command"
                    value={command}
                    rows={5}
                    className="resize-y overflow-x-auto text-xs"
                    style={{
                      fontFamily: "var(--font-mono-stack)",
                    }}
                  />
                </CardContent>
              </Card>
            )}

            {idmItems.length > 0 && (
              <Card>
                <CardHeader className="flex-row flex-wrap items-center justify-between gap-4 space-y-0">
                  <CardTitle className="text-base">
                    IDM export ({idmReadyCount} ready URLs)
                  </CardTitle>

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">Format: .txt</span>

                    <Button variant="secondary" size="sm" onClick={copyIdm} disabled={!idmList}>
                      {copiedIdm ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      {copiedIdm ? "Copied" : "Copy URLs"}
                    </Button>

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => downloadText(idmExport, exportName(idmItems, url, "txt"))}
                      disabled={!idmExport}
                    >
                      <FileDown className="h-4 w-4" />
                      Download .txt
                    </Button>
                  </div>
                </CardHeader>

                <CardContent className="grid gap-3">
                  <p className="text-xs text-muted-foreground">
                    The .txt URL list works with IDM → Tasks → Add Batch Download From Clipboard.
                  </p>

                  {idmHasFileKeeper && (
                    <div className="rounded-md border border-primary/40 bg-primary/5 p-3 space-y-2">
                      <p className="text-xs text-muted-foreground">
                        FileKeeper pages are excluded from the ready URL list. Export the helper
                        below and run <code>py filekeeper-idm.py</code> in its folder on your
                        Windows PC (Python 3 required). It resolves selected FileKeeper links in
                        batches, retaining the countdown and session cookies, without downloading
                        the files. IDM imports the resulting URLs through its clipboard batch
                        dialog.
                      </p>
                      <p className="text-xs text-amber-500">
                        <strong>Important for IDM:</strong> FileKeeper tunnel links can return
                        <code className="mx-1">HTTP 403 Forbidden</code> when IDM uses its default
                        User-Agent. In IDM, use this User-Agent:
                        <code className="mt-1 block break-all rounded bg-background/70 p-2">
                          {UA}
                        </code>
                        <a
                          href="https://www.internetdownloadmanager.com/support/using_idm/using_idm.html"
                          target="_blank"
                          rel="noreferrer"
                          className="mt-2 inline-flex items-center gap-1 underline underline-offset-2 hover:no-underline"
                        >
                          Step-by-step IDM download instructions
                          <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        </a>
                        <span className="mt-1 block">
                          In IDM: open <strong>Options → General → User-Agent</strong>, paste the
                          value above, click <strong>OK</strong>, then retry with a fresh link.
                        </span>
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            downloadText(buildFileKeeperIdmScript(idmItems), "filekeeper-idm.py")
                          }
                        >
                          <FileDown className="h-4 w-4" />
                          Download script
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy || cloudflareFileKeeperItems.length === 0}
                          onClick={() =>
                            resolveFileKeeperMutation.mutate(cloudflareFileKeeperItems)
                          }
                        >
                          <CloudDownload className="h-4 w-4" />
                          Run in browser
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Run in browser resolves selected pages in batches of up to 100 and downloads
                        a .txt URL list. For larger selections, use the downloaded script in
                        batches.
                      </p>
                      {cloudflareProgress && (
                        <div className="grid gap-2" aria-live="polite">
                          <div className="flex justify-between text-xs text-muted-foreground">
                            <span>Cloudflare resolution progress</span>
                            <span>
                              {cloudflareProgress.done} / {cloudflareProgress.total}
                            </span>
                          </div>
                          <Progress
                            value={(cloudflareProgress.done / cloudflareProgress.total) * 100}
                            aria-label={`Resolved ${cloudflareProgress.done} of ${cloudflareProgress.total} FileKeeper links`}
                          />
                        </div>
                      )}
                      <p className="text-xs text-amber-500">
                        Signed URLs expire quickly. Start IDM immediately after importing the URL
                        list. Browser verification may still be required for some files.
                      </p>
                    </div>
                  )}

                  <Textarea
                    readOnly
                    aria-label="IDM download URLs"
                    value={idmList}
                    rows={Math.min(idmItems.length + 1, 14)}
                    className="resize-y text-xs"
                    style={{
                      fontFamily: "var(--font-mono-stack)",
                    }}
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

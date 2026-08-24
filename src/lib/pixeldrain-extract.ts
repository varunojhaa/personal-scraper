export type HostKey = "pixeldrain" | "fileditch" | "fuckingfast" | "datanodes" | "filekeeper";

export type PixeldrainItem = {
  id: string;
  kind: "file" | "list";
  host: HostKey;
  pageUrl: string;
  directUrl: string;
  foundOn: string;
  /** Real filename, looked up from the host when available. */
  filename?: string;
  /** Recommended downloader for this host. */
  tool: "wget" | "idm";
  /** True for bonus/selective files you can skip (fg-optional-*, fg-selective-*, …). */
  optional?: boolean;
};

export type ScrapeResult = {
  sourceUrl: string;
  items: PixeldrainItem[];
  pagesScanned: string[];
  protectedPages: string[];
  scrapedAt: string;
};

export const HOST_LABELS: Record<HostKey, string> = {
  pixeldrain: "Pixeldrain",
  fileditch: "FileDitch",
  fuckingfast: "FuckingFast",
  datanodes: "DataNodes",
  filekeeper: "FileKeeper",
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

type Rule = {
  re: RegExp;
  host: HostKey;
  kind: "file" | "list";
  page: (id: string) => string;
  direct: (id: string) => string;
  tool: "wget" | "idm";
};

const RULES: Rule[] = [
  {
    re: /pixeldrain\.com\/(?:u|api\/file)\/([A-Za-z0-9]{4,12})/gi,
    host: "pixeldrain",
    kind: "file",
    page: (id) => `https://pixeldrain.com/u/${id}`,
    direct: (id) => `https://pixeldrain.com/api/file/${id}?download`,
    tool: "wget",
  },
  {
    re: /pixeldrain\.com\/l\/([A-Za-z0-9]{4,12})/gi,
    host: "pixeldrain",
    kind: "list",
    page: (id) => `https://pixeldrain.com/l/${id}`,
    direct: (id) => `https://pixeldrain.com/api/list/${id}/zip`,
    tool: "wget",
  },
  {
    // Direct FileDitch file links, e.g.
    // https://fileditchfiles.st/beta24/<hash>/Some.File.mkv
    re: /((?:[a-z0-9-]+\.)?fileditch(?:files)?\.(?:st|me|com)\/[^\s"'<>]{4,300}\.[A-Za-z0-9]{2,5})/gi,
    host: "fileditch",
    kind: "file",
    page: (id) => `https://${id}`,
    direct: (id) => `https://${id}`,
    tool: "wget",
  },
  {
    re: /fuckingfast\.(?:co|net)\/([A-Za-z0-9]{4,40}(?:#[^\s"'<>]{0,200})?)/gi,
    host: "fuckingfast",
    kind: "file",
    page: (id) => `https://fuckingfast.co/${id}`,
    direct: (id) => `https://fuckingfast.co/${id}`,
    tool: "idm",
  },
  {
    re: /datanodes\.to\/([A-Za-z0-9]{4,40}(?:\/[^\s"'<>]{0,200})?)/gi,
    host: "datanodes",
    kind: "file",
    page: (id) => `https://datanodes.to/${id}`,
    direct: (id) => `https://datanodes.to/${id}`,
    tool: "idm",
  },
  {
    re: /filekeeper\.net\/([A-Za-z0-9]{4,40}(?:\/[^\s"'<>]{0,200})?)/gi,
    host: "filekeeper",
    kind: "file",
    page: (id) => `https://filekeeper.net/${id}`,
    direct: (id) => `https://filekeeper.net/${id}`,
    tool: "idm",
  },
];

/**
 * Pull the displayed filename out of a link id. For FuckingFast the name lives
 * in the URL fragment (`#name`); for DataNodes/FileKeeper it is the last path
 * segment. Pixeldrain ids are opaque codes with no filename.
 */
function nameFromId(host: HostKey, id: string): string {
  if (host === "fuckingfast") {
    const frag = id.split("#")[1];
    if (frag) {
      try {
        return decodeURIComponent(frag);
      } catch {
        return frag;
      }
    }
    return "";
  }
  if (host === "pixeldrain") return "";
  const seg = id.split("/").filter(Boolean).pop() ?? "";
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/**
 * FitGirl labels optional content with a filename prefix like `fg-optional-`
 * or `fg-selective-`. These are bonus soundtracks, language packs, HD texture
 * packs, etc. — you can skip them and the repack still installs.
 */
export function isOptionalName(name: string): boolean {
  const n = name.toLowerCase();
  return /\bfg-(optional|selective|choose|online|multi|bonus|redist)\b/.test(n) ||
    /\b(optional|selective)\b/i.test(n);
}

export function extract(html: string, foundOn: string, into: Map<string, PixeldrainItem>) {
  for (const rule of RULES) {
    for (const m of html.matchAll(rule.re)) {
      const id = (m[1] ?? "").replace(/[.,;)\]]+$/, "");
      if (!id) continue;
      // Key on the id without its filename fragment so the same file pasted
      // twice (or found by both a scrape and a paste) is only listed once.
      const key = `${rule.host}:${rule.kind}:${id.split("#")[0]}`;
      if (into.has(key)) continue;
      const name = nameFromId(rule.host, id);
      const optional = name ? isOptionalName(name) : false;
      into.set(key, {
        id,
        kind: rule.kind,
        host: rule.host,
        foundOn,
        pageUrl: rule.page(id),
        directUrl: rule.direct(id),
        tool: rule.tool,
        optional,
        ...(rule.host !== "pixeldrain" && name ? { filename: name } : {}),
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

/** Every item this file host recognises. */
export function isFileHostUrl(url: string) {
  return /(?:pixeldrain\.com|fileditch(?:files)?\.(?:st|me|com)|fuckingfast\.(?:co|net)|datanodes\.to|filekeeper\.net)/i.test(
    url,
  );
}

/**
 * One copy-pasteable shell block: paste it into a terminal and every file
 * downloads (resumable, correct filenames, referer + UA set for hosts that
 * need them).
 */
function shellQuote(name: string) {
  return `'${name.replace(/'/g, "'\\''")}'`;
}

function fileDitchCommand(item: PixeldrainItem, common: string) {
  const filename = item.filename ?? "fileditch-download";
  const python = `import hashlib,html as H,json,re,shlex,subprocess,sys,urllib.parse,urllib.request
url,name=sys.argv[1],sys.argv[2]
ua=${JSON.stringify(UA)}
opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor())
def request(target,data=None):
    req=urllib.request.Request(target,data=data,headers={"User-Agent":ua,"Accept":"text/html,application/xhtml+xml,*/*"})
    with opener.open(req,timeout=60) as response:
        return response.geturl(),response.read().decode("utf-8","replace")
def direct(page):
    match=re.search(r"var\\s+u\\s*=\\s*(\\[[\\s\\S]*?\\])\\.join\\([\\\"']{2}\\)",page,re.I)
    return "".join(json.loads(match.group(1))) if match else ""
final,page=request(url)
media=direct(page)
if not media:
    fields={H.unescape(k):H.unescape(v) for k,v in re.findall(r"<input\\b[^>]*\\bname=[\\\"']([^\\\"']+)[\\\"'][^>]*\\bvalue=[\\\"']([^\\\"']*)[\\\"'][^>]*>",page,re.I)}
    challenge=fields.get("pow_challenge","")
    difficulty=int(fields.get("pow_diff","0"))
    if not challenge or difficulty<1: raise SystemExit("FileDitch verification challenge was not found")
    nonce=0
    while True:
        digest=hashlib.sha256((challenge+":"+str(nonce)).encode()).digest()
        bits="".join(format(byte,"08b") for byte in digest[:((difficulty+7)//8)])
        if bits.startswith("0"*difficulty): break
        nonce+=1
    fields["pow_nonce"]=str(nonce)
    final,page=request(final,urllib.parse.urlencode(fields).encode())
    media=direct(page)
if not media.startswith("https://"): raise SystemExit("FileDitch did not return a download URL")
raise SystemExit(subprocess.call(["wget",*shlex.split(${JSON.stringify(common)}),"-O",name,"--user-agent="+ua,"--referer="+url,media]))`;
  return `python3 -c ${shellQuote(python)} ${shellQuote(item.pageUrl)} ${shellQuote(filename)}`;
}

export function buildWget(items: PixeldrainItem[]) {
  if (!items.length) return "";
  // Common flags: retry on stalls instead of hanging forever, resume partial
  // files, and force connection close per request. --no-http-keep-alive is
  // essential: pixeldrain's 416 "already fully retrieved" response keeps the
  // connection open and wget hangs waiting on it (verified against the live
  // API — without this flag the command never returns and you must Ctrl+C).
  const common = `-c --tries=5 --timeout=30 --read-timeout=60 --waitretry=5 --no-http-keep-alive`;
  const segments = items.map((i) => {
    const out = i.filename ? ` -O ${shellQuote(i.filename)}` : "";
    // --content-disposition is only needed to name the output file when we
    // don't pass -O. It also triggers the 416 hang, so we drop it whenever we
    // already have a resolved filename (which is the normal case: pixeldrain
    // names come from the API, the other hosts embed them in the URL).
    const cd = i.filename ? "" : " --content-disposition";
    const cmd =
      i.host === "pixeldrain"
        ? `wget${cd} ${common}${out} "${i.directUrl}"`
        : i.host === "fileditch"
          ? fileDitchCommand(i, common)
          : `wget${cd} ${common}${out} --user-agent="${UA}" --referer="${i.pageUrl}" "${i.directUrl}"`;
    // Finished files leave a .done marker, so a re-run skips them instead of
    // re-opening a connection that stalls and needs Ctrl+C. Partial files have
    // no marker, so they still resume with -c. Because the 416 path now exits
    // 0 (thanks to --no-http-keep-alive), a file that finished without a
    // marker self-heals: wget returns, `touch .done` runs, and it's skipped
    // forever after.
    if (!i.filename) return cmd;
    const done = shellQuote(`${i.filename}.done`);
    return `[ -f ${done} ] || { ${cmd} && touch ${done}; }`;
  });
  // Join with "; " so the whole thing is one command line; a single file's
  // failure won't stop the rest (no && chaining).
  const script = segments.join("; ");
  // Run detached: setsid + nohup put the whole sequence in its own session so
  // it survives closing the terminal / SSH session. Output goes to wget.log,
  // and the PID is printed so you can `kill` it or `tail -f wget.log`.
  return `setsid nohup bash -c ${shellQuote(script)} > wget.log 2>&1 < /dev/null & disown; echo "started in background (PID $!) — watch progress with: tail -f wget.log"\n`;
}
/**
 * A ready-to-run download.sh: same commands as the copy-paste one-liner, but
 * written out one per line with a shebang so it can be saved and executed
 * (`bash download.sh`).
 */
export function buildShellScript(items: PixeldrainItem[]) {
  if (!items.length) return "";
  const common = `-c --tries=5 --timeout=30 --read-timeout=60 --waitretry=5 --no-http-keep-alive`;
  const lines = items.map((i) => {
    const out = i.filename ? ` -O ${shellQuote(i.filename)}` : "";
    const cd = i.filename ? "" : " --content-disposition";
    const cmd =
      i.host === "pixeldrain"
        ? `wget${cd} ${common}${out} "${i.directUrl}"`
        : i.host === "fileditch"
          ? fileDitchCommand(i, common)
          : `wget${cd} ${common}${out} --user-agent="${UA}" --referer="${i.pageUrl}" "${i.directUrl}"`;
    const label = i.filename || i.pageUrl;
    if (!i.filename) return `# ${label}\n${cmd} || echo "FAILED: ${label}" >&2`;
    const done = shellQuote(`${i.filename}.done`);
    return `# ${label}\nif [ -f ${done} ]; then\n  echo "skip (already done): ${i.filename}"\nelse\n  ${cmd} && touch ${done} || echo "FAILED: ${i.filename}" >&2\nfi`;
  });
  return [
    "#!/usr/bin/env bash",
    "# Generated by Personal Scraper",
    `# ${items.length} file(s). Run with: bash download.sh`,
    "# Finished files leave a .done marker, so re-running skips them.",
    "set -u",
    "",
    ...lines,
    "",
    'echo "All done."',
    "",
  ].join("\n");
}

/**
 * Friendly validation for the manual paste / URL box. Returns an error message
 * when we know the input can never produce links, otherwise null.
 */
export function validateManualInput(raw: string): string | null {
  const text = raw.trim();
  if (!text) return "Paste a link first — the box is empty.";
  if (text.length < 8) return "That's too short to be a link. Paste the full URL.";
  const looksLikeHtml = /<\w+[\s>]/.test(text);
  const urls = text.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  if (!urls.length && !looksLikeHtml) {
    if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(text))
      return "Add http:// or https:// in front of that address.";
    return "No URL found. Paste a full link starting with https://, or the page HTML.";
  }
  if (looksLikeHtml) return null;
  if (urls.some((u) => isFileHostUrl(u))) return null;
  const protectedHit = urls.find((u) => isProtected(u));
  if (protectedHit) {
    let host = protectedHit;
    try {
      host = new URL(protectedHit).hostname;
    } catch {
      /* keep raw */
    }
    return `${host} is captcha-protected — open it, solve the captcha, then paste the revealed Pixeldrain link or upload its .dlc container.`;
  }
  return `Unsupported link. This scraper only understands ${Object.values(HOST_LABELS).join(", ")} links (or raw page HTML that contains them).`;
}

/**
 * Build a meaningful + unique export filename derived from the actual file
 * names being downloaded. For a single file it uses that file's name; for
 * multiple files it finds their longest common prefix (e.g. a repack name)
 * and appends the file count + timestamp so exports never collide.
 *
 *   Cyberpunk.2077.Repack.sh
 *   Red-Dead-Redemption-2-12files-20260824-1530.ef2
 */
export function exportName(
  items: PixeldrainItem[],
  fallback: string,
  ext: string,
): string {
  const names = items
    .map((i) => i.filename || i.id || "")
    .filter(Boolean)
    .map((n) => n.replace(/\.[^./\\]+$/, "")); // strip extension

  let slug = "";
  if (names.length === 1) {
    slug = names[0] ?? "";
  } else if (names.length > 1) {
    slug = commonPrefix(names);
  }

  if (!slug) {
    // Fall back to the source hostname.
    let host = "";
    try {
      const src = items[0]?.foundOn || fallback || "";
      if (src) host = new URL(src).hostname.replace(/^www\./, "");
    } catch {
      host = fallback || "";
    }
    slug = host || "downloads";
  }

  slug = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "downloads";

  const n = items.length;
  // Single-file exports keep the clean file name; multi-file exports append
  // the count so they stay descriptive without random trailing numbers.
  return n === 1
    ? `${slug}.${ext}`
    : `${slug}-${n}files.${ext}`;
}

/** Longest common leading token-prefix shared by every entry (case-insensitive). */
function commonPrefix(names: string[]): string {
  if (names.length < 2) return names[0] ?? "";
  const norm = names.map((n) => n.toLowerCase());
  // Split on typical separators so a shared title is detected even when the
  // trailing tokens differ (e.g. "Game.Repack.part1" / "Game.Repack.part2").
  const tokenize = (s: string) => s.split(/[\s._\-]+/).filter(Boolean);
  const first = tokenize(norm[0] ?? "");
  let i = 0;
  outer: for (; i < first.length; i++) {
    for (let j = 1; j < norm.length; j++) {
      if (tokenize(norm[j] ?? "")[i] !== first[i]) break outer;
    }
  }
  // Keep at least one token; if only a trivial prefix matches, fall back to the
  // first file's name (minus extension) as the representative slug.
  const prefix = first.slice(0, Math.max(i, 1)).join("-");
  return prefix || (names[0] ?? "");
}

/** Plain URL list — paste into IDM › Tasks › Add Batch Download from Clipboard. */
export function buildIdmList(items: PixeldrainItem[]) {

  return items.map((i) => i.directUrl).join("\n");
}

/** IDM .ef2 export format — File › Import › From IDM export file. */
export function buildIdmEf2(items: PixeldrainItem[]) {
  return items
    .map((i) => `<\n${i.directUrl}\nreferer: ${i.pageUrl}\nUser-Agent: ${UA}\n>`)
    .join("\n");
}

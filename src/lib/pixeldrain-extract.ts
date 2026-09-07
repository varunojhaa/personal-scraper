export type HostKey = "pixeldrain" | "datanodes" | "filekeeper";

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
  /** Optional/selective content; installation requirements vary by file. */
  optional?: boolean;
  /** Session cookie captured while resolving a FileKeeper link. */
  cookie?: string;
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
  datanodes: "DataNodes",
  filekeeper: "FileKeeper",
};

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

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

const COMMON_WGET =
  "-c --tries=5 --timeout=30 --read-timeout=60 " + "--waitretry=5 --no-http-keep-alive";

const RULES: Rule[] = [
  {
    re: /pixeldrain\.com\/(?:u|api\/file)\/([A-Za-z0-9]{4,12})(?![A-Za-z0-9])/gi,
    host: "pixeldrain",
    kind: "file",
    page: (id) => `https://pixeldrain.com/u/${id}`,
    direct: (id) => `https://pixeldrain.com/api/file/${id}?download`,
    tool: "wget",
  },
  {
    re: /pixeldrain\.com\/(?:l|api\/list)\/([A-Za-z0-9]{4,12})(?![A-Za-z0-9])/gi,
    host: "pixeldrain",
    kind: "list",
    page: (id) => `https://pixeldrain.com/l/${id}`,
    direct: (id) => `https://pixeldrain.com/api/list/${id}/zip`,
    tool: "wget",
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
    // Signed download URLs may be much longer than 300 characters.
    re: /(https:\/\/(?:[a-z0-9-]+\.)*dlproxy\.uk\/download\/[^\s"'<>\\]+)/gi,
    host: "filekeeper",
    kind: "file",
    page: (id) => id,
    direct: (id) => id,
    tool: "wget",
  },
  {
    re: /filekeeper\.net\/([A-Za-z0-9]{4,40}(?:\/[^\s"'<>?#]*)?)/gi,
    host: "filekeeper",
    kind: "file",
    page: (id) => `https://filekeeper.net/${id}`,
    direct: (id) => `https://filekeeper.net/${id}`,
    tool: "wget",
  },
];

function decodeUrlText(value: string): string {
  return value.replace(/&amp;/gi, "&").replace(/&#(?:0*38|x0*26);/gi, "&");
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Keep host-provided filenames inside the current download directory. */
function safeFilename(value: string): string {
  const basename = value.replace(/\\/g, "/").split("/").pop() ?? "";

  const cleaned = Array.from(basename)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim();

  return /^\.+$/.test(cleaned) ? "" : cleaned;
}

/**
 * Bare DataNodes/FileKeeper codes and signed tunnel tokens
 * should not be used as filenames.
 */
function nameFromId(host: HostKey, id: string): string {
  if (host === "pixeldrain") return "";

  if (host === "filekeeper" && /^https?:\/\//i.test(id)) {
    return "";
  }

  const path = id.split(/[?#]/)[0] ?? "";
  const segments = path.split("/").filter(Boolean);

  if ((host === "filekeeper" || host === "datanodes") && segments.length < 2) {
    return "";
  }

  return safeFilename(decodeComponent(segments[segments.length - 1] ?? ""));
}

export function isOptionalName(name: string): boolean {
  return (
    /\bfg-(optional|selective|choose|online|multi|bonus|redist)\b/i.test(name) ||
    /\b(optional|selective)\b/i.test(name)
  );
}

export function extract(html: string, foundOn: string, into: Map<string, PixeldrainItem>): void {
  // Also recognize URLs copied from JSON-escaped page text.
  const text = html.replace(/\\\//g, "/");

  for (const rule of RULES) {
    for (const match of text.matchAll(rule.re)) {
      // Do not interpret lookalike hostnames (e.g. notpixeldrain.com) as supported hosts.
      const preceding = text[(match.index ?? 0) - 1];
      if (preceding && /[a-z0-9_-]/i.test(preceding)) continue;
      let id = decodeUrlText(match[1] ?? "");

      // Preserve signed tunnel URLs exactly, including trailing punctuation.
      if (!(rule.host === "filekeeper" && /^https:\/\//i.test(id))) {
        id = id.replace(/[.,;)\]]+$/, "");
      }

      if (!id) continue;

      const key = `${rule.host}:${rule.kind}:${id.split("#")[0]}`;
      const name = nameFromId(rule.host, id);
      const existing = into.get(key);

      if (existing) {
        if (!existing.filename && name) {
          existing.filename = name;
          existing.optional = isOptionalName(name);
        }

        continue;
      }

      into.set(key, {
        id,
        kind: rule.kind,
        host: rule.host,
        pageUrl: rule.page(id),
        directUrl: rule.direct(id),
        foundOn,
        tool: rule.tool,
        optional: name ? isOptionalName(name) : false,
        ...(name ? { filename: name } : {}),
      });
    }
  }
}

export function collectLinks(html: string, base: string): string[] {
  const out = new Set<string>();
  const text = html.replace(/\\\//g, "/");

  function add(raw: string): void {
    const value = decodeUrlText(raw.trim());

    if (!value || value.startsWith("#")) return;

    try {
      const url = /^https?:\/\//i.test(value) ? new URL(value) : new URL(value, base);

      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return;
      }

      url.hash = "";
      out.add(url.toString());
    } catch {
      // Ignore malformed URLs.
    }
  }

  const attributes = /(?:href|data-href|data-url|content)\s*=\s*["']([^"']+)["']/gi;

  for (const match of text.matchAll(attributes)) {
    add(match[1] ?? "");
  }

  for (const match of text.matchAll(/https?:\/\/[^\s"'<>\\)]+/gi)) {
    add((match[0] ?? "").replace(/[.,;]+$/, ""));
  }

  return [...out];
}

function matchesHost(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function isProtected(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();

    return PROTECTED_HOSTS.some((domain) => matchesHost(hostname, domain));
  } catch {
    return false;
  }
}

export function isFileHostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();

    const domains = [
      "pixeldrain.com",
      // Unsupported hosts remain here so scans/pasted URLs never fetch their pages.
      "fuckingfast.co",
      "fuckingfast.net",
      "datanodes.to",
      "filekeeper.net",
    ];

    return (
      domains.some((domain) => matchesHost(hostname, domain)) ||
      (matchesHost(hostname, "dlproxy.uk") && parsed.pathname.startsWith("/download/"))
    );
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Resolve FileKeeper using cookies and recognized free-download forms.
 *
 * Handles HTTP redirects, same-origin refreshes, and the countdown widget.
 * Does not execute arbitrary JavaScript or solve CAPTCHAs.
 * Unrecognized responses are saved to private debug HTML files.
 */
function fileKeeperCommand(item: PixeldrainItem, common: string): string {
  const filename = safeFilename(item.filename ?? "");
  return (
    `python3 -c ${shellQuote(fileKeeperPython(common))} ` +
    `${shellQuote(item.pageUrl)} ${shellQuote(filename)}`
  );
}

function fileKeeperPython(common: string, batch = false): string {
  return String.raw`import html as H
import http.cookiejar
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

${batch ? 'url,name="",""' : "url,name=sys.argv[1],sys.argv[2]"}
ua=${JSON.stringify(UA)}
MAX_HTML=4*1024*1024
MAX_STEPS=10

def is_download(target):
    try:
        p=urllib.parse.urlsplit(target)
        host=(p.hostname or "").lower()
        return (
            p.scheme=="https"
            and not p.username
            and not p.password
            and (host=="dlproxy.uk" or host.endswith(".dlproxy.uk"))
            and p.path.startswith("/download/")
        )
    except ValueError:
        return False

def is_filekeeper_page(target):
    try:
        p=urllib.parse.urlsplit(target)
        host=(p.hostname or "").lower()
        return (
            p.scheme in ("http","https")
            and not p.username
            and not p.password
            and (host=="filekeeper.net" or host.endswith(".filekeeper.net"))
        )
    except ValueError:
        return False

def normalize(value,base):
    value=H.unescape(value).replace("\\/","/").strip()
    return urllib.parse.urljoin(base,value)

def same_origin(first,second):
    try:
        a=urllib.parse.urlsplit(first)
        b=urllib.parse.urlsplit(second)

        def origin(p):
            default=443 if p.scheme=="https" else 80
            port=p.port
            return (
                p.scheme.lower(),
                (p.hostname or "").lower(),
                default if port is None else port,
            )

        return (
            a.scheme in ("http","https")
            and b.scheme in ("http","https")
            and not b.username
            and not b.password
            and origin(a)==origin(b)
        )
    except ValueError:
        return False

def refresh_parts(content):
    match=re.search(r"url\s*=\s*(.+)",content,re.I)
    if not match:
        return None

    target=match.group(1).strip().strip("\"'")
    if not target:
        return None

    delay_match=re.match(r"\s*(\d+(?:\.\d+)?)",content)
    delay=float(delay_match.group(1)) if delay_match else 0
    return delay,target

def wait_for(delay):
    if delay>600:
        raise SystemExit(
            "FileKeeper requests a wait longer than 10 minutes. "
            "Please use the browser."
        )

    if delay>0:
        print(
            "FileKeeper: waiting %s seconds..." % (delay+1),
            flush=True,
        )
        time.sleep(delay+1)

class DownloadRedirect(Exception):
    def __init__(self,target):
        super().__init__(target)
        self.url=target

class RedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        target=normalize(newurl,req.full_url)

        if is_download(target):
            fp.close()
            raise DownloadRedirect(target)

        old=urllib.parse.urlsplit(req.full_url)
        new=urllib.parse.urlsplit(target)

        if (
            not is_filekeeper_page(target)
            or (old.scheme=="https" and new.scheme!="https")
        ):
            fp.close()
            raise SystemExit(
                "FileKeeper redirected to an unsupported or insecure "
                "destination. Use the browser to continue."
            )

        return super().redirect_request(
            req,fp,code,msg,headers,newurl
        )

jar=http.cookiejar.MozillaCookieJar()

opener=urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(jar),
    RedirectHandler(),
)

def get(target,data=None,referer=None):
    if is_download(target) and data is None:
        return target,"",target,""

    if not is_filekeeper_page(target):
        raise SystemExit("Unsupported FileKeeper request destination.")

    headers={
        "User-Agent":ua,
        "Accept":"text/html,application/xhtml+xml,*/*",
        "Accept-Language":"en-US,en;q=0.9",
    }

    if referer:
        headers["Referer"]=referer

    if data is not None:
        headers["Content-Type"]="application/x-www-form-urlencoded"

    request=urllib.request.Request(
        target,data=data,headers=headers
    )

    try:
        with opener.open(request,timeout=60) as response:
            final=response.geturl()
            content_type=response.headers.get_content_type()
            disposition=response.headers.get("Content-Disposition","")
            refresh=response.headers.get("Refresh","")

            binary=(
                content_type.startswith("application/")
                and content_type not in (
                    "application/xhtml+xml",
                    "application/json",
                    "application/xml",
                    "application/javascript",
                )
            ) or content_type.startswith(("audio/","video/","image/"))

            if (
                is_download(final)
                or "attachment" in disposition.lower()
                or binary
            ):
                # Do not load binary files into memory as HTML.
                if data is not None:
                    raise SystemExit(
                        "FileKeeper returned a file directly to a POST "
                        "request instead of a reusable download URL. "
                        "Use the browser for this download."
                    )
                return final,"",final,""

            body=response.read(MAX_HTML+1)

            if len(body)>MAX_HTML:
                raise SystemExit(
                    "FileKeeper returned an unexpectedly large page."
                )

            encoding=response.headers.get_content_charset() or "utf-8"
            try:
                page=body.decode(encoding,"replace")
            except LookupError:
                page=body.decode("utf-8","replace")

            return final,page,"",refresh

    except DownloadRedirect as result:
        return target,"",result.url,""

    except urllib.error.HTTPError as error:
        body=error.read(262144).decode("utf-8","replace")

        if re.search(
            r"Just a moment|cf-chl|challenges\.cloudflare\.com",
            body,re.I,
        ):
            raise SystemExit(
                "FileKeeper requires browser verification. Open the "
                "original file page, click Free Download, and paste "
                "the freshly generated tunnel URL."
            )

        raise SystemExit(
            "FileKeeper returned HTTP %s while requesting %s. "
            "This may be an unavailable file, expired session, or "
            "rejected request; it does not prove the file was deleted."
            % (error.code,target)
        )

    except urllib.error.URLError as error:
        raise SystemExit(
            "FileKeeper request failed: "+str(error.reason)
        )

class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.forms=[]
        self.current=None
        self.button=None
        self.links=[]
        self.refreshes=[]
        self.countdowns=[]

    def handle_starttag(self,tag,attrs):
        tag=tag.lower()
        a=dict(attrs)

        if tag=="div" and a.get("id")=="download-countdown":
            self.countdowns.append(a)

        for key in ("href","data-href","data-url"):
            if a.get(key):
                self.links.append(a[key])

        if (
            tag=="meta"
            and (a.get("http-equiv") or "").lower()=="refresh"
        ):
            refresh=refresh_parts(a.get("content") or "")
            if refresh:
                self.refreshes.append(refresh)

        if tag=="form":
            self.current={
                "action":a.get("action") or "",
                "method":(a.get("method") or "get").lower(),
                "fields":[],
                "buttons":[],
            }
            self.forms.append(self.current)
            self.button=None
            return

        if self.current is None:
            return

        if tag=="input":
            if "disabled" in a:
                return

            kind=(a.get("type") or "text").lower()
            field=a.get("name") or ""
            value=a.get("value") or ""

            if kind in ("submit","image"):
                self.current["buttons"].append({
                    "name":field,
                    "value":value,
                    "text":value,
                    "attrs":a,
                    "image":kind=="image",
                })

            elif (
                field
                and kind not in ("button","reset","file")
                and (
                    kind not in ("checkbox","radio")
                    or "checked" in a
                )
            ):
                default="on" if kind in ("checkbox","radio") else ""
                self.current["fields"].append((
                    field,a.get("value",default) or ""
                ))

        elif tag=="button":
            if (
                "disabled" not in a
                and (a.get("type") or "submit").lower()=="submit"
            ):
                self.button={
                    "name":a.get("name") or "",
                    "value":a.get("value") or "",
                    "text":"",
                    "attrs":a,
                    "image":False,
                }
                self.current["buttons"].append(self.button)

    def handle_data(self,data):
        if self.button is not None:
            self.button["text"]+=data

    def handle_endtag(self,tag):
        tag=tag.lower()
        if tag=="button":
            self.button=None
        elif tag=="form":
            self.button=None
            self.current=None

def direct(page,base,parsed):
    for candidate in parsed.links:
        target=normalize(candidate,base)
        if is_download(target):
            return target

    text=H.unescape(page).replace("\\/","/")
    pattern=r"https://(?:[a-z0-9-]+\.)*dlproxy\.uk/download/[^\s\"'<>\\]+"

    for match in re.finditer(pattern,text,re.I):
        target=match.group(0)
        if is_download(target):
            return target

    return ""

def next_refresh(parsed,base):
    for delay,candidate in parsed.refreshes:
        target=normalize(candidate,base)

        if is_download(target):
            return delay,target

        if same_origin(base,target):
            target=urllib.parse.urldefrag(target)[0]
            current=urllib.parse.urldefrag(base)[0]

            if target!=current:
                return delay,target

    return None

def button_score(button):
    label=" ".join((
        button["name"],
        button["value"],
        button["text"],
        button["attrs"].get("id") or "",
    )).lower()

    if "premium" in label:
        return -100
    if "method_free" in label:
        return 100
    if "free" in label:
        return 80
    if "download" in label:
        return 40
    if "continue" in label:
        return 10
    return 0

def choose_form(parsed):
    candidates=[]

    for form in parsed.forms:
        fields=form["fields"]
        keys={key.lower() for key,value in fields}
        values={key.lower():value.lower() for key,value in fields}

        score=0
        if values.get("op","").startswith("download"):
            score+=60
        if keys.intersection({"file_code","id","rand","down_script"}):
            score+=20
        if "method_free" in keys:
            score+=80

        available=[
            button for button in form["buttons"]
            if button_score(button)>=0
        ]
        button=max(available,key=button_score) if available else None

        if button is not None:
            score+=button_score(button)
        elif form["buttons"]:
            # Do not submit forms that only offer premium buttons.
            continue

        if score>0:
            candidates.append((score,form,button))

    if not candidates:
        return None

    _,form,button=max(candidates,key=lambda row:row[0])
    return form,button

def countdown_form(parsed):
    # FileKeeper's countdown widget creates this form only on click.
    # Reproduce that known flow from HTML attributes; never execute scripts.
    if not parsed.countdowns:
        return None
    if len(parsed.countdowns)!=1:
        raise ValueError("ambiguous download countdown widgets")

    attrs=parsed.countdowns[0]
    for key,label in (
        ("data-has-password","a file password"),
        ("data-has-captcha","a CAPTCHA"),
    ):
        if attrs.get(key)=="true":
            raise ValueError("download requires "+label+"; use the browser")
        if attrs.get(key)!="false":
            raise ValueError("missing or invalid countdown protection flags")

    code=attrs.get("data-code") or ""
    if not re.fullmatch(r"[A-Za-z0-9]{4,40}",code):
        raise ValueError("missing or invalid countdown file code")
    if "data-rand" not in attrs or attrs["data-rand"] is None:
        raise ValueError("missing countdown rand field")

    raw_delay=attrs.get("data-countdown") or ""
    if not re.fullmatch(r"[+-]?\d+",raw_delay.strip()):
        raise ValueError("missing or invalid download countdown")
    # Match the widget's parseInt(...) || 5, including its zero fallback.
    delay=int(raw_delay) or 5

    return ({
        "action":"",
        "method":"post",
        "fields":[
            ("op","download2"),
            ("id",code),
            ("rand",attrs["data-rand"]),
            ("referer",attrs.get("data-referer") or ""),
            ("method_free",attrs.get("data-method") or "Free download"),
            ("down_direct","1"),
        ],
        "buttons":[],
        "delay":delay,
    },None)

def countdown(page):
    patterns=(
        r"(?:var\s+)?(?:countdown|seconds|wait_time)\s*[:=]\s*[\"']?(\d{1,4})",
        r"(?:id=[\"'](?:countdown|countdown_str|seconds)[\"'][^>]*>)\s*(\d{1,4})",
        r"(?:countdown|wait)\s*\(\s*(\d{1,4})",
        r"wait\s+(\d{1,4})\s+seconds",
    )

    for pattern in patterns:
        match=re.search(pattern,page,re.I)
        if match:
            return int(match.group(1))

    return 0

def form_request(final,form,button):
    fields=list(form["fields"])
    action=form["action"]
    method=form["method"]

    if button is not None:
        attrs=button["attrs"]

        if "formaction" in attrs:
            action=attrs["formaction"] or ""
        if attrs.get("formmethod"):
            method=attrs["formmethod"].lower()

        if button["name"]:
            if button["image"]:
                fields.extend([
                    (button["name"]+".x","1"),
                    (button["name"]+".y","1"),
                ])
            else:
                fields.append((button["name"],button["value"]))

    target=normalize(action,final) if action else final
    target=urllib.parse.urldefrag(target)[0]

    if not same_origin(final,target):
        raise SystemExit(
            "FileKeeper returned a cross-origin or insecure form action. "
            "Use the browser to continue safely."
        )

    encoded=urllib.parse.urlencode(fields)

    if method=="post":
        return target,encoded.encode()

    if method=="get":
        parts=urllib.parse.urlsplit(target)
        return urllib.parse.urlunsplit((
            parts.scheme,parts.netloc,parts.path,encoded,""
        )),None

    raise SystemExit("Unsupported FileKeeper form method: "+method)

def unresolved_page(final,page,parsed,reason):
    # Private, unique file: HTML may contain session tokens.
    try:
        fd,path=tempfile.mkstemp(
            prefix="filekeeper-debug-",
            suffix=".html",
            dir=os.getcwd(),
        )
    except OSError:
        fd,path=tempfile.mkstemp(
            prefix="filekeeper-debug-",
            suffix=".html",
        )

    with os.fdopen(fd,"w",encoding="utf-8") as output:
        output.write(page)

    print("FileKeeper: "+reason+" at "+final,file=sys.stderr)
    print(
        "Detected %s form(s), %s link(s), and %s refresh redirect(s)."
        % (
            len(parsed.forms),
            len(parsed.links),
            len(parsed.refreshes),
        ),
        file=sys.stderr,
    )
    print("Response HTML saved to: "+path,file=sys.stderr)
    print(
        "The debug HTML may contain private tokens or signed links. "
        "Redact those before sharing it.",
        file=sys.stderr,
    )

    raise SystemExit(
        "Inspect the saved HTML for the required form, redirect, "
        "JavaScript request, or browser verification. Alternatively, "
        "open the original file page and paste a fresh tunnel URL."
    )

def main(resolve_only=False):
    if not is_download(url) and not is_filekeeper_page(url):
        raise SystemExit(
            "Expected a FileKeeper page or dlproxy.uk download URL."
        )

    referer="https://filekeeper.net/"

    if is_download(url):
        link=url
        final=referer
        page=""
        refresh_header=""
    else:
        final,page,link,refresh_header=get(url,referer=referer)

    for step in range(MAX_STEPS+1):
        if link:
            break

        parsed=PageParser()
        parsed.feed(page)
        parsed.close()

        if refresh_header:
            refresh=refresh_parts(refresh_header)
            if refresh:
                parsed.refreshes.insert(0,refresh)

        if re.search(
            r"Just a moment|cf-chl|challenges\.cloudflare\.com",
            page,re.I,
        ):
            raise SystemExit(
                "FileKeeper requires a browser check. Open the page "
                "in your browser and paste the fresh tunnel URL."
            )

        # Follow intermediate refresh pages, not only tunnel refreshes.
        refresh=next_refresh(parsed,final)

        if refresh:
            if step==MAX_STEPS:
                unresolved_page(
                    final,page,parsed,"redirect/form step limit reached"
                )

            delay,target=refresh
            wait_for(delay)
            referer=final
            final,page,link,refresh_header=get(target,referer=referer)
            continue

        link=direct(page,final,parsed)
        if link:
            referer=final
            break

        if step==MAX_STEPS:
            unresolved_page(
                final,page,parsed,"redirect/form step limit reached"
            )

        selected=choose_form(parsed)
        if selected is None:
            try:
                selected=countdown_form(parsed)
            except ValueError as error:
                unresolved_page(final,page,parsed,str(error))

        if selected is None:
            unresolved_page(
                final,page,parsed,
                "no recognized free-download form or tunnel link",
            )

        form,button=selected
        wait_for(form.get("delay",countdown(page)))
        target,data=form_request(final,form,button)
        referer=final

        print(
            "FileKeeper: submitting download step %s..." % (step+1),
            flush=True,
        )

        final,page,link,refresh_header=get(
            target,data=data,referer=referer
        )

    if not link:
        raise SystemExit("FileKeeper did not provide a download URL.")

    if resolve_only:
        request=urllib.request.Request(link)
        jar.add_cookie_header(request)
        return link,referer,request.get_header("Cookie","")

    with tempfile.TemporaryDirectory(prefix="filekeeper-") as directory:
        cookies=os.path.join(directory,"cookies.txt")
        jar.save(cookies,ignore_discard=True,ignore_expires=False)
        os.chmod(cookies,0o600)

        cmd=[
            "wget",
            *shlex.split(${JSON.stringify(common)}),
            "--user-agent="+ua,
            "--referer="+referer,
            "--load-cookies="+cookies,
        ]

        if name:
            cmd.extend(["-O",name])
        else:
            cmd.append("--content-disposition")

        print("FileKeeper: starting download...",flush=True)
        result=subprocess.call(cmd+["--",link])

        if result:
            print(
                "FileKeeper download failed. Signed tunnel URLs may "
                "expire or be single-use. Generate a new command using "
                "the original FileKeeper page to request a fresh link.",
                file=sys.stderr,
            )

        return result

${
  batch
    ? ""
    : String.raw`try:
    raise SystemExit(main())
except KeyboardInterrupt:
    raise SystemExit(130)
except OSError as error:
    raise SystemExit("FileKeeper resolver failed: "+str(error))
`
}`;
}

/** Resolve on the IDM user's computer, retaining its IP and session context. */
export function buildFileKeeperIdmScript(items: PixeldrainItem[]): string {
  const files = items
    .filter((item) => item.host === "filekeeper")
    .map((item) => ({ url: item.pageUrl, name: safeFilename(item.filename ?? "") }));
  if (!files.length) return "";

  return (
    fileKeeperPython("", true) +
    String.raw`
import argparse
import datetime
import json
import traceback

FILES=json.loads(${JSON.stringify(JSON.stringify(files))})

def single_line(value):
    return value.replace("\r","").replace("\n","")

def export_idm():
    global url,name
    parser=argparse.ArgumentParser(
        description="Resolve FileKeeper locally, then import the URL list into IDM immediately."
    )
    parser.add_argument("--start",type=int,default=1,help="First selected file (1-based)")
    parser.add_argument("--count",type=int,default=100,help="Batch size (default: 100; maximum: all selected files)")
    default_output="filekeeper-idm-%s.txt" % datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    parser.add_argument("--output",default=default_output,help="IDM TXT URL list; never overwritten")
    args=parser.parse_args()
    if args.start<1 or args.start>len(FILES) or args.count<1 or args.count>len(FILES):
        parser.error("start must be within the selected files and count must be between 1 and the number of selected files")
    batch=FILES[args.start-1:args.start-1+args.count]
    # Signed URLs and cookies are private. Refuse to overwrite earlier exports.
    fd=os.open(args.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    succeeded=0
    with os.fdopen(fd,"w",encoding="utf-8",newline="") as output:
        for index,item in enumerate(batch,args.start):
            url,name=item["url"],item["name"]
            jar.clear()
            print("Resolving file %s/%s: %s" % (index,len(FILES),name or "FileKeeper"),flush=True)
            try:
                link,referer,cookie=main(resolve_only=True)
                output.write(single_line(link)+"\r\n")
                output.flush()
                succeeded+=1
            except (SystemExit,OSError,ValueError) as error:
                print("File %s failed: %s" % (index,error),file=sys.stderr)
    print("Exported %s/%s IDM URLs to %s. In IDM use Tasks -> Add batch download from clipboard." % (succeeded,len(batch),args.output))
    print("Keep this file private: it may contain signed URLs and session cookies.")
    next_start=args.start+len(batch)
    if next_start<=len(FILES):
        print("Next batch: --start %s --count %s --output filekeeper-idm-%s.txt" % (next_start,args.count,next_start))
    return 0 if succeeded==len(batch) else 1

if __name__=="__main__":
    exit_code=0
    try:
        exit_code=export_idm()
    except KeyboardInterrupt:
        print("Cancelled.",file=sys.stderr)
        exit_code=130
    except Exception as error:
        print("IDM export failed: "+str(error),file=sys.stderr)
        traceback.print_exc()
        exit_code=1
    if sys.platform=="win32" and sys.stdin.isatty():
        input("\nPress Enter to close...")
    raise SystemExit(exit_code)
`
  );
}

/** Shared command generation for both export formats. */
function itemCommand(item: PixeldrainItem): { command: string; filename: string } {
  const filename = safeFilename(item.filename ?? "");

  const normalized: PixeldrainItem = {
    ...item,
  };

  if (filename) {
    normalized.filename = filename;
  } else {
    delete normalized.filename;
  }

  if (item.host === "filekeeper") {
    return {
      filename,
      command: fileKeeperCommand(normalized, COMMON_WGET),
    };
  }

  const output = filename ? ` -O ${shellQuote(filename)}` : " --content-disposition";

  const headers =
    item.host === "pixeldrain"
      ? ""
      : ` --user-agent=${shellQuote(UA)}` + ` --referer=${shellQuote(item.pageUrl)}`;

  return {
    filename,
    command: `wget ${COMMON_WGET}${output}${headers} -- ` + shellQuote(item.directUrl),
  };
}

function completedTest(filename: string): string {
  // A stale marker must not skip a deleted output file.
  return `[ -f ${shellQuote(`${filename}.done`)} ] && ` + `[ -f ${shellQuote(filename)} ]`;
}

export function buildWget(items: PixeldrainItem[]): string {
  if (!items.length) return "";

  const segments = items.map((item) => {
    const { command, filename } = itemCommand(item);

    if (!filename) return command;

    const done = shellQuote(`${filename}.done`);

    return `if ${completedTest(filename)}; then :; ` + `else ${command} && touch -- ${done}; fi`;
  });

  const script = segments.join("; ");

  return (
    `setsid nohup bash -c ${shellQuote(script)}` +
    ` > wget.log 2>&1 < /dev/null & ` +
    `pid=$!; disown "$pid" 2>/dev/null || true; ` +
    `echo "started in background (PID $pid) — ` +
    `watch progress with: tail -f wget.log"\n`
  );
}

export function buildShellScript(items: PixeldrainItem[]): string {
  if (!items.length) return "";

  const lines = items.map((item) => {
    const { command, filename } = itemCommand(item);
    const label = filename || item.pageUrl;

    const failure =
      `printf '%s\\n' ${shellQuote(`FAILED: ${label}`)} >&2\n` + `    failed=$((failed + 1))`;

    if (!filename) {
      return [
        `printf '%s\\n' ${shellQuote(`Downloading: ${label}`)}`,
        `if ! ${command}; then`,
        `    ${failure}`,
        "fi",
      ].join("\n");
    }

    return [
      `if ${completedTest(filename)}; then`,
      `  printf '%s\\n' ${shellQuote(`skip (already done): ${filename}`)}`,
      "else",
      `  printf '%s\\n' ${shellQuote(`Downloading: ${filename}`)}`,
      `  if ${command} && touch -- ${shellQuote(`${filename}.done`)}; then`,
      "    :",
      "  else",
      `    ${failure}`,
      "  fi",
      "fi",
    ].join("\n");
  });

  return [
    "#!/usr/bin/env bash",
    "# Generated by Personal Scraper",
    `# ${items.length} file(s). Run with: bash download.sh`,
    "# Requires wget; resolver hosts also require python3.",
    "# Known filenames receive .done markers after successful downloads.",
    "set -u",
    "failed=0",
    "",
    ...lines,
    "",
    'if [ "$failed" -gt 0 ]; then',
    '  printf "Finished with %s failed download(s).\\n" "$failed" >&2',
    "  exit 1",
    "fi",
    'echo "All downloads completed."',
    "",
  ].join("\n");
}

export function validateManualInput(raw: string): string | null {
  const text = raw.trim();

  if (!text) {
    return "Paste a link first — the box is empty.";
  }

  if (text.length < 8) {
    return "That's too short to be a link. Paste the full URL.";
  }

  const looksLikeHtml = /<\w+[\s>]/.test(text);
  const urls = text.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];

  if (!urls.length && !looksLikeHtml) {
    if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(text)) {
      return "Add http:// or https:// in front of that address.";
    }

    return "No URL found. Paste a full link starting with https://, " + "or the page HTML.";
  }

  if (looksLikeHtml) return null;
  if (urls.some((url) => isFileHostUrl(url))) return null;

  const protectedHit = urls.find((url) => isProtected(url));

  if (protectedHit) {
    let host = protectedHit;

    try {
      host = new URL(protectedHit).hostname;
    } catch {
      // Keep the original value.
    }

    return (
      `${host} is captcha-protected — open it, solve the captcha, ` +
      "then paste the revealed supported-host links or upload " +
      "its .dlc container."
    );
  }

  return (
    "Unsupported link. This scraper only understands " +
    Object.values(HOST_LABELS).join(", ") +
    " links (or raw page HTML that contains them)."
  );
}

/** Derive a readable export filename from selected files. */
export function exportName(items: PixeldrainItem[], fallback: string, ext: string): string {
  const names = items
    .map((item) => item.filename || item.id || "")
    .filter(Boolean)
    .map((name) => name.replace(/\.[^./\\]+$/, ""));

  let slug = "";

  if (names.length === 1) {
    slug = names[0] ?? "";
  } else if (names.length > 1) {
    slug = commonPrefix(names);
  }

  if (!slug) {
    let host = "";

    try {
      const source = items[0]?.foundOn || fallback || "";

      if (source) {
        host = new URL(source).hostname.replace(/^www\./, "");
      }
    } catch {
      host = fallback || "";
    }

    slug = host || "downloads";
  }

  slug =
    slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "downloads";

  return items.length === 1 ? `${slug}.${ext}` : `${slug}-${items.length}files.${ext}`;
}

function commonPrefix(names: string[]): string {
  if (names.length < 2) return names[0] ?? "";

  const tokens = names.map((name) =>
    name
      .toLowerCase()
      .split(/[\s._-]+/)
      .filter(Boolean),
  );

  const first = tokens[0] ?? [];
  let index = 0;

  outer: for (; index < first.length; index++) {
    for (let other = 1; other < tokens.length; other++) {
      if (tokens[other]?.[index] !== first[index]) {
        break outer;
      }
    }
  }

  return first.slice(0, Math.max(index, 1)).join("-") || names[0] || "";
}

/** A FileKeeper URL is IDM-ready only after its countdown has produced a signed URL. */
function isResolvedFileKeeperUrl(item: PixeldrainItem): boolean {
  if (item.host !== "filekeeper") return true;

  try {
    const url = new URL(item.directUrl);
    const host = url.hostname.toLowerCase();
    return (
      (host === "dlproxy.uk" || host.endsWith(".dlproxy.uk")) &&
      url.pathname.startsWith("/download/")
    );
  } catch {
    return false;
  }
}

/** Plain URL list for IDM; unresolved FileKeeper pages are intentionally omitted. */
export function buildIdmList(items: PixeldrainItem[]): string {
  return items
    .filter(isResolvedFileKeeperUrl)
    .map((item) => item.directUrl)
    .join("\n");
}

export function isIdmReady(item: PixeldrainItem): boolean {
  return isResolvedFileKeeperUrl(item);
}

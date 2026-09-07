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
  /** Optional/selective content; installation requirements vary by file. */
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

const COMMON_WGET = "-c --tries=5 --timeout=30 --read-timeout=60 --waitretry=5 --no-http-keep-alive";

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
    re: /pixeldrain\.com\/l\/([A-Za-z0-9]{4,12})(?![A-Za-z0-9])/gi,
    host: "pixeldrain",
    kind: "list",
    page: (id) => `https://pixeldrain.com/l/${id}`,
    direct: (id) => `https://pixeldrain.com/api/list/${id}/zip`,
    tool: "wget",
  },
  {
    re: /((?:[a-z0-9-]+\.)?fileditch(?:files)?\.(?:st|me|com)\/[^\s"'<>]{4,300}\.[A-Za-z0-9]{2,5}(?:\?[^\s"'<>]*)?)/gi,
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
    // Signed FileKeeper download links can be much longer than 300 chars.
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
  return (
    value
      .replace(/\\/g, "/")
      .split("/")
      .pop()!
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/^\.+$/, "")
      .trim()
  );
}

/**
 * Bare DataNodes/FileKeeper file codes are not filenames.
 * Signed tunnel URL tokens are not filenames either.
 */
function nameFromId(host: HostKey, id: string): string {
  if (host === "pixeldrain") return "";

  if (host === "fuckingfast") {
    const index = id.indexOf("#");
    return index >= 0 ? safeFilename(decodeComponent(id.slice(index + 1))) : "";
  }

  if (host === "filekeeper" && /^https?:\/\//i.test(id)) {
    return "";
  }

  const path = id.split(/[?#]/)[0] ?? "";
  const segments = path.split("/").filter(Boolean);

  if ((host === "filekeeper" || host === "datanodes") && segments.length < 2) {
    return "";
  }

  return safeFilename(decodeComponent(segments.at(-1) ?? ""));
}

export function isOptionalName(name: string): boolean {
  return (
    /\bfg-(optional|selective|choose|online|multi|bonus|redist)\b/i.test(name) || /\b(optional|selective)\b/i.test(name)
  );
}

export function extract(html: string, foundOn: string, into: Map<string, PixeldrainItem>) {
  for (const rule of RULES) {
    for (const match of html.matchAll(rule.re)) {
      const id = decodeUrlText(match[1] ?? "").replace(/[.,;)\]]+$/, "");
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

export function collectLinks(html: string, base: string) {
  const out = new Set<string>();

  function add(raw: string) {
    const value = decodeUrlText(raw.trim());
    if (!value || value.startsWith("#")) return;

    try {
      const url = new URL(value, base);
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      url.hash = "";
      out.add(url.toString());
    } catch {
      // Ignore malformed URLs.
    }
  }

  const attributes = /(?:href|data-href|data-url|content)\s*=\s*["']([^"']+)["']/gi;

  for (const match of html.matchAll(attributes)) {
    add(match[1] ?? "");
  }

  // No 300-character limit: FileKeeper signed URLs are often much longer.
  for (const match of html.matchAll(/https?:\/\/[^\s"'<>\\)]+/gi)) {
    add((match[0] ?? "").replace(/[.,;]+$/, ""));
  }

  return [...out];
}

function matchesHost(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function isProtected(url: string) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return PROTECTED_HOSTS.some((domain) => matchesHost(hostname, domain));
  } catch {
    return false;
  }
}

export function isFileHostUrl(url: string) {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();
    const domains = [
      "pixeldrain.com",
      "fileditch.st",
      "fileditch.me",
      "fileditch.com",
      "fileditchfiles.st",
      "fileditchfiles.me",
      "fileditchfiles.com",
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

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function sanitizeClearance(raw: string) {
  const value = /cf_clearance\s*[=:]\s*([^\s;,"']+)/i.exec(raw)?.[1] ?? raw;

  return (
    value
      .trim()
      // eslint-disable-next-line no-control-regex
      .replace(/[^\u0021-\u007e]/g, "")
      .replace(/[;,"']/g, "")
  );
}

function fileDitchCommand(item: PixeldrainItem, common: string, rawClearance = "") {
  const clearance = sanitizeClearance(rawClearance);
  const filename = safeFilename(item.filename ?? "") || "fileditch-download";

  const python = String.raw`import hashlib,html as H,json,re,shlex,subprocess,sys,urllib.error,urllib.parse,urllib.request
url,name,clearance=sys.argv[1],sys.argv[2],sys.argv[3]
ua=${JSON.stringify(UA)}
opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor())

def headers():
    h={"User-Agent":ua,"Accept":"text/html,application/xhtml+xml,*/*","Accept-Language":"en-US,en;q=0.9"}
    if clearance:
        h["Cookie"]="cf_clearance="+clearance
    return h

def request(target,data=None):
    req=urllib.request.Request(target,data=data,headers=headers())
    try:
        with opener.open(req,timeout=60) as response:
            return response.geturl(),response.read().decode("utf-8","replace")
    except urllib.error.HTTPError as err:
        body=err.read(262144).decode("utf-8","replace")
        if err.code in (403,503) and re.search(r"Just a moment|cf-chl|challenges\.cloudflare\.com",body,re.I):
            raise SystemExit("FileDitch requires browser verification. Open the file page in your browser and use a fresh cf_clearance cookie; it may also be tied to your browser and IP.")
        raise SystemExit("FileDitch returned HTTP %s for %s" % (err.code,target))
    except urllib.error.URLError as err:
        raise SystemExit("FileDitch request failed: "+str(err.reason))

def direct(page):
    match=re.search(r"var\s+u\s*=\s*(\[[\s\S]*?\])\.join\([\"']{2}\)",page,re.I)
    return "".join(json.loads(match.group(1))) if match else ""

final,page=request(url)
media=direct(page)

if not media:
    fields={H.unescape(k):H.unescape(v) for k,v in re.findall(r"<input\b[^>]*\bname=[\"']([^\"']+)[\"'][^>]*\bvalue=[\"']([^\"']*)[\"'][^>]*>",page,re.I)}
    challenge=fields.get("pow_challenge","")
    try:
        difficulty=int(fields.get("pow_diff","0"))
    except ValueError:
        raise SystemExit("FileDitch returned an invalid verification difficulty")
    if not challenge or not 1<=difficulty<=24:
        raise SystemExit("FileDitch verification challenge was not found or its difficulty is unsupported")

    nonce=0
    while True:
        digest=hashlib.sha256((challenge+":"+str(nonce)).encode()).digest()
        if int.from_bytes(digest,"big") >> (256-difficulty) == 0:
            break
        nonce+=1

    fields["pow_nonce"]=str(nonce)
    final,page=request(final,urllib.parse.urlencode(fields).encode())
    media=direct(page)

if not media.startswith("https://"):
    raise SystemExit("FileDitch did not return a download URL")

cmd=["wget",*shlex.split(${JSON.stringify(common)}),"-O",name,"--user-agent="+ua,"--referer="+url]
if clearance:
    cmd.append("--header=Cookie: cf_clearance="+clearance)
raise SystemExit(subprocess.call(cmd+["--",media]))
`;

  return `python3 -c ${shellQuote(python)} ${shellQuote(
    item.pageUrl,
  )} ${shellQuote(filename)} ${shellQuote(clearance)}`;
}

/**
 * Resolve FileKeeper using a cookie jar and the actual free-download form.
 *
 * Important:
 * - Include the clicked free-download submit button.
 * - Do not submit premium buttons or unchecked controls.
 * - Catch tunnel redirects before urllib downloads the file.
 * - Pass applicable cookies to wget using a temporary Netscape cookie file.
 * - Never use the opaque file code / signed token as a filename.
 */
function fileKeeperCommand(item: PixeldrainItem, common: string) {
  const filename = safeFilename(item.filename ?? "");

  const python = String.raw`import html as H
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

url,name=sys.argv[1],sys.argv[2]
ua=${JSON.stringify(UA)}
MAX_HTML=4*1024*1024

def is_download(target):
    p=urllib.parse.urlsplit(target)
    host=(p.hostname or "").lower()
    return (
        p.scheme=="https"
        and (host=="dlproxy.uk" or host.endswith(".dlproxy.uk"))
        and p.path.startswith("/download/")
    )

def normalize(value,base):
    value=H.unescape(value).replace("\\/","/").strip()
    return urllib.parse.urljoin(base,value)

class DownloadRedirect(Exception):
    def __init__(self,url):
        self.url=url

class RedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        target=normalize(newurl,req.full_url)
        if is_download(target):
            # Cookie processing takes place before the redirect handler.
            fp.close()
            raise DownloadRedirect(target)
        return super().redirect_request(req,fp,code,msg,headers,newurl)

jar=http.cookiejar.MozillaCookieJar()
opener=urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(jar),
    RedirectHandler(),
)

def get(target,data=None,referer=None):
    if is_download(target) and data is None:
        return target,"",target

    headers={
        "User-Agent":ua,
        "Accept":"text/html,application/xhtml+xml,*/*",
        "Accept-Language":"en-US,en;q=0.9",
    }
    if referer:
        headers["Referer"]=referer
    if data is not None:
        headers["Content-Type"]="application/x-www-form-urlencoded"

    request=urllib.request.Request(target,data=data,headers=headers)

    try:
        with opener.open(request,timeout=60) as response:
            final=response.geturl()
            content_type=response.headers.get_content_type()
            disposition=response.headers.get("Content-Disposition","")

            if (
                is_download(final)
                or "attachment" in disposition.lower()
                or content_type not in (
                    "text/html",
                    "application/xhtml+xml",
                    "text/plain",
                )
            ):
                # Never read a binary file into memory as HTML.
                # A non-tunnel attachment endpoint may need a browser if
                # it cannot be requested again with GET.
                if data is not None:
                    raise SystemExit(
                        "FileKeeper returned the file directly to a POST request "
                        "instead of a reusable download URL. Use the browser "
                        "for this download."
                    )
                return final,"",final

            body=response.read(MAX_HTML+1)
            if len(body)>MAX_HTML:
                raise SystemExit("FileKeeper returned an unexpectedly large HTML page")
            encoding=response.headers.get_content_charset() or "utf-8"
            try:
                page=body.decode(encoding,"replace")
            except LookupError:
                page=body.decode("utf-8","replace")
            return final,page,""

    except DownloadRedirect as result:
        return target,"",result.url

    except urllib.error.HTTPError as error:
        body=error.read(262144).decode("utf-8","replace")
        if re.search(r"Just a moment|cf-chl|challenges\.cloudflare\.com",body,re.I):
            raise SystemExit(
                "FileKeeper requires browser verification. Open the original "
                "file page in your browser, click Free Download, and paste "
                "the freshly generated tunnel URL."
            )
        raise SystemExit(
            "FileKeeper returned HTTP %s while requesting %s. "
            "This can be a missing file, expired session, or rejected download "
            "request; it does not by itself prove the file was deleted."
            % (error.code,target)
        )

    except urllib.error.URLError as error:
        raise SystemExit("FileKeeper request failed: "+str(error.reason))

class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.forms=[]
        self.current=None
        self.button=None
        self.links=[]
        self.refreshes=[]

    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        tag=tag.lower()

        for key in ("href","data-href","data-url"):
            if a.get(key):
                self.links.append(a[key])

        if tag=="meta" and a.get("http-equiv","").lower()=="refresh":
            match=re.search(r"url\s*=\s*(.+)",a.get("content",""),re.I)
            if match:
                self.refreshes.append(match.group(1).strip().strip("\"'"))

        if tag=="form":
            self.current={
                "action":a.get("action",""),
                "method":a.get("method","get").lower(),
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
            kind=a.get("type","text").lower()
            field=a.get("name","")
            value=a.get("value","")

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
                and (kind not in ("checkbox","radio") or "checked" in a)
            ):
                self.current["fields"].append((
                    field,
                    a.get("value","on" if kind in ("checkbox","radio") else ""),
                ))

        elif tag=="button":
            if "disabled" not in a and a.get("type","submit").lower()=="submit":
                self.button={
                    "name":a.get("name",""),
                    "value":a.get("value",""),
                    "text":"",
                    "attrs":a,
                    "image":False,
                }
                self.current["buttons"].append(self.button)

    def handle_data(self,data):
        if self.button is not None:
            self.button["text"]+=data

    def handle_endtag(self,tag):
        if tag.lower()=="button":
            self.button=None
        elif tag.lower()=="form":
            self.button=None
            self.current=None

def direct(page,base,parsed):
    for candidate in parsed.links+parsed.refreshes:
        target=normalize(candidate,base)
        if is_download(target):
            return target

    # Handles ordinary and JSON-escaped URLs, including long signed tokens.
    text=H.unescape(page).replace("\\/","/")
    pattern=r"https://(?:[a-z0-9-]+\.)*dlproxy\.uk/download/[^\s\"'<>\\]+"
    for match in re.finditer(pattern,text,re.I):
        target=match.group(0)
        if is_download(target):
            return target
    return ""

def button_score(button):
    label=" ".join((
        button["name"],
        button["value"],
        button["text"],
        button["attrs"].get("id",""),
    )).lower()

    if "premium" in label or "method_premium" in label:
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
            # A form with only premium buttons is not a free-download form.
            continue

        if score>0:
            candidates.append((score,form,button))

    if not candidates:
        return None
    _,form,button=max(candidates,key=lambda row:row[0])
    return form,button

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
            delay=int(match.group(1))
            if delay>600:
                raise SystemExit(
                    "FileKeeper requests a wait longer than 10 minutes. "
                    "Please use the browser."
                )
            return delay
    return 0

def form_request(final,form,button):
    fields=list(form["fields"])
    action=form["action"]
    method=form["method"]

    if button is not None:
        attrs=button["attrs"]
        action=attrs.get("formaction",action)
        method=attrs.get("formmethod",method).lower()

        if button["name"]:
            if button["image"]:
                fields.extend([
                    (button["name"]+".x","1"),
                    (button["name"]+".y","1"),
                ])
            else:
                fields.append((button["name"],button["value"]))

    target=normalize(action,final) if action else final

    # Do not send hidden session fields to an unrelated form destination.
    origin=urllib.parse.urlsplit(final)
    destination=urllib.parse.urlsplit(target)
    if (
        destination.scheme not in ("http","https")
        or destination.netloc.lower()!=origin.netloc.lower()
        or (origin.scheme=="https" and destination.scheme!="https")
    ):
        raise SystemExit(
            "FileKeeper returned a cross-origin or insecure form action. "
            "Use the browser to continue safely."
        )

    encoded=urllib.parse.urlencode(fields)

    if method=="post":
        return target,encoded.encode()

    if method=="get":
        parts=urllib.parse.urlsplit(target)
        # HTML GET form submission replaces the action query.
        return urllib.parse.urlunsplit((
            parts.scheme,parts.netloc,parts.path,encoded,"",
        )),None

    raise SystemExit("Unsupported FileKeeper form method: "+method)

def main():
    referer="https://filekeeper.net/"
    link=""

    if is_download(url):
        link=url
        final=referer
        page=""
    else:
        final,page,link=get(url,referer=referer)
        referer=final

    for step in range(6):
        if link:
            break

        parsed=PageParser()
        parsed.feed(page)
        link=direct(page,final,parsed)
        if link:
            referer=final
            break

        if re.search(r"Just a moment|cf-chl|challenges\.cloudflare\.com",page,re.I):
            raise SystemExit(
                "FileKeeper requires a browser check. Open the page in your "
                "browser and paste the fresh tunnel download link."
            )

        selected=choose_form(parsed)
        if selected is None:
            raise SystemExit(
                "No usable FileKeeper free-download form or tunnel link "
                "was found at "+final+". The page may need JavaScript, "
                "a captcha, or the file may be unavailable. Open the page "
                "in your browser to check."
            )

        delay=countdown(page)
        if delay:
            print("FileKeeper: waiting %s seconds..." % (delay+1),flush=True)
            time.sleep(delay+1)

        form,button=selected
        target,data=form_request(final,form,button)
        referer=final
        final,page,link=get(target,data=data,referer=referer)

    if not link:
        raise SystemExit(
            "FileKeeper did not provide a download URL after 6 steps. "
            "Open the file page, click Free Download, and paste the new "
            "tunnel URL instead."
        )

    # Netscape cookie format is understood by wget. Cookie domain/path rules
    # prevent FileKeeper-only cookies from being sent to unrelated hosts.
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
            # Let the server provide the real filename.
            cmd.append("--content-disposition")

        print("FileKeeper: starting download...",flush=True)
        result=subprocess.call(cmd+["--",link])

        if result:
            print(
                "FileKeeper download failed. Signed tunnel URLs may expire "
                "or be single-use. Rebuild using the original FileKeeper "
                "page URL to request a fresh link.",
                file=sys.stderr,
            )
        return result

try:
    raise SystemExit(main())
except KeyboardInterrupt:
    raise SystemExit(130)
`;

  return `python3 -c ${shellQuote(python)} ${shellQuote(item.pageUrl)} ${shellQuote(filename)}`;
}

/** Shared command generation for both export formats. */
function itemCommand(item: PixeldrainItem, clearance = ""): { command: string; filename: string } {
  const filename = safeFilename(item.filename ?? "");
  const normalized = {
    ...item,
    filename: filename || undefined,
  };

  if (item.host === "fileditch") {
    return {
      filename,
      command: fileDitchCommand(normalized, COMMON_WGET, clearance),
    };
  }

  if (item.host === "filekeeper") {
    return {
      filename,
      command: fileKeeperCommand(normalized, COMMON_WGET),
    };
  }

  const output = filename ? ` -O ${shellQuote(filename)}` : " --content-disposition";

  const headers =
    item.host === "pixeldrain" ? "" : ` --user-agent=${shellQuote(UA)} --referer=${shellQuote(item.pageUrl)}`;

  return {
    filename,
    command: `wget ${COMMON_WGET}${output}${headers} -- ${shellQuote(item.directUrl)}`,
  };
}

function completedTest(filename: string): string {
  // A stale marker must not cause a deleted output file to be skipped.
  return `[ -f ${shellQuote(`${filename}.done`)} ] && [ -f ${shellQuote(filename)} ]`;
}

export function buildWget(items: PixeldrainItem[], clearance = "") {
  if (!items.length) return "";

  const segments = items.map((item) => {
    const { command, filename } = itemCommand(item, clearance);

    if (!filename) return command;

    const done = shellQuote(`${filename}.done`);
    return `if ${completedTest(filename)}; then :; else ${command} && touch -- ${done}; fi`;
  });

  const script = segments.join("; ");

  // Requires bash, setsid, nohup, wget, and python3 for resolver hosts.
  return (
    `setsid nohup bash -c ${shellQuote(script)}` +
    ` > wget.log 2>&1 < /dev/null & ` +
    `pid=$!; disown "$pid" 2>/dev/null || true; ` +
    `echo "started in background (PID $pid) — watch progress with: tail -f wget.log"\n`
  );
}

export function buildShellScript(items: PixeldrainItem[], clearance = "") {
  if (!items.length) return "";

  const lines = items.map((item) => {
    const { command, filename } = itemCommand(item, clearance);
    const label = filename || item.pageUrl;

    const failure = `printf '%s\\n' ${shellQuote(`FAILED: ${label}`)} >&2\n` + `    failed=$((failed + 1))`;

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

  if (!text) return "Paste a link first — the box is empty.";
  if (text.length < 8) {
    return "That's too short to be a link. Paste the full URL.";
  }

  const looksLikeHtml = /<\w+[\s>]/.test(text);
  const urls = text.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];

  if (!urls.length && !looksLikeHtml) {
    if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(text)) {
      return "Add http:// or https:// in front of that address.";
    }

    return "No URL found. Paste a full link starting with https://, or the page HTML.";
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

    return `${host} is captcha-protected — open it, solve the captcha, then paste the revealed supported-host links or upload its .dlc container.`;
  }

  return `Unsupported link. This scraper only understands ${Object.values(HOST_LABELS).join(
    ", ",
  )} links (or raw page HTML that contains them).`;
}

/** Derive a readable export filename from the selected files. */
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

/**
 * Plain URL list.
 * FileKeeper page URLs still require browser/IDM host support;
 * these synchronous exports do not resolve signed links.
 */
export function buildIdmList(items: PixeldrainItem[]) {
  return items.map((item) => item.directUrl).join("\n");
}

/** IDM .ef2 export format. */
export function buildIdmEf2(items: PixeldrainItem[]) {
  const singleLine = (value: string) => value.replace(/[\r\n]/g, "");

  return items
    .map((item) => `<\n${singleLine(item.directUrl)}\nreferer: ${singleLine(item.pageUrl)}\nUser-Agent: ${UA}\n>`)
    .join("\n");
}

import { UA } from "./pixeldrain-extract.ts";

// Keep the request under typical Cloudflare Worker CPU/time limits: each
// FileKeeper countdown can take several seconds before its POST is accepted.
const MAX_BATCH = 3;
const MAX_STEPS = 6;
const MAX_HTML = 4 * 1024 * 1024;

type FileInput = { pageUrl: string };
type Resolved = { url: string; referer: string; cookie: string };

function isPage(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      (host === "filekeeper.net" || host.endsWith(".filekeeper.net"))
    );
  } catch {
    return false;
  }
}

function isDownload(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (host === "dlproxy.uk" || host.endsWith(".dlproxy.uk")) &&
      url.pathname.startsWith("/download/")
    );
  } catch {
    return false;
  }
}

function updateCookies(response: Response, previous: string): string {
  const jar = new Map<string, string>();
  for (const part of previous.split(/;\s*/)) {
    const index = part.indexOf("=");
    if (index > 0) jar.set(part.slice(0, index), part.slice(index + 1));
  }
  const setCookie = response.headers.get("set-cookie") ?? "";
  for (const part of setCookie.split(/,(?=[^;,=]+=[^;,]+)/)) {
    const first = part.split(";", 1)[0] ?? "";
    const index = first.indexOf("=");
    if (index > 0) jar.set(first.slice(0, index).trim(), first.slice(index + 1).trim());
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function sameOrigin(base: string, value: string): string {
  const target = new URL(value, base);
  const source = new URL(base);
  if (
    target.protocol !== source.protocol ||
    target.hostname !== source.hostname ||
    target.port !== source.port ||
    target.username ||
    target.password
  ) {
    throw new Error("FileKeeper returned an unsafe cross-origin step.");
  }
  target.hash = "";
  return target.href;
}

function findDownload(html: string): string | undefined {
  const matches =
    html.match(/https:\/\/(?:[a-z0-9-]+\.)*dlproxy\.uk\/download\/[^\s"'<>\\]+/gi) ?? [];
  return matches.map((value) => value.replace(/&amp;/gi, "&")).find(isDownload);
}

function getAttribute(tag: string, name: string): string {
  return tag.match(new RegExp(`${name}=["']([^"']*)["']`, "i"))?.[1] ?? "";
}

function getCountdown(html: string): { delay: number; body: string } | undefined {
  const tag = html.match(
    /<[^>]+(?:id=["']download-countdown["'][^>]*|data-code=["'][^"']+["'][^>]*)>/i,
  )?.[0];
  if (!tag) return undefined;
  if (
    getAttribute(tag, "data-has-password") === "true" ||
    getAttribute(tag, "data-has-captcha") === "true"
  ) {
    throw new Error("FileKeeper requires a password or CAPTCHA; use the browser.");
  }
  const code = getAttribute(tag, "data-code");
  const delay = Number.parseInt(getAttribute(tag, "data-countdown"), 10);
  if (!/^[A-Za-z0-9]{4,40}$/.test(code) || !Number.isInteger(delay) || delay < 0 || delay > 15) {
    throw new Error("FileKeeper returned an unsupported countdown; use the browser.");
  }
  const fields = new URLSearchParams({
    op: "download2",
    id: code,
    rand: getAttribute(tag, "data-rand"),
    referer: getAttribute(tag, "data-referer"),
    method_free: getAttribute(tag, "data-method") || "Free download",
    down_direct: "1",
  });
  return { delay: delay || 5, body: fields.toString() };
}

async function resolveOne(pageUrl: string): Promise<Resolved> {
  if (!isPage(pageUrl)) throw new Error("Only FileKeeper page URLs are allowed.");
  let current = pageUrl;
  let referer = "https://filekeeper.net/";
  let cookie = "";
  let method = "GET";
  let body: string | undefined;

  for (let step = 0; step <= MAX_STEPS; step++) {
    const response = await fetch(current, {
      method,
      ...(body ? { body } : {}),
      redirect: "manual",
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,*/*",
        ...(referer ? { Referer: referer } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
    });
    cookie = updateCookies(response, cookie);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("FileKeeper returned an invalid redirect.");
      const target = new URL(location, current).href;
      if (isDownload(target)) return { url: target, referer: current, cookie };
      referer = current;
      current = sameOrigin(current, target);
      method = "GET";
      body = undefined;
      continue;
    }
    if (!response.ok) throw new Error(`FileKeeper returned HTTP ${response.status}.`);
    const html = await response.text();
    if (html.length > MAX_HTML) throw new Error("FileKeeper returned an unexpectedly large page.");
    if (/Just a moment|cf-chl|challenges\.cloudflare\.com/i.test(html)) {
      throw new Error("FileKeeper requires browser verification; use the browser.");
    }
    const download = findDownload(html);
    if (download) return { url: download, referer: current, cookie };
    const countdown = getCountdown(html);
    if (!countdown) throw new Error("FileKeeper returned an unsupported page; use the browser.");
    await new Promise((resolve) => setTimeout(resolve, countdown.delay * 1000 + 250));
    referer = current;
    method = "POST";
    body = countdown.body;
  }
  throw new Error("FileKeeper redirect/form step limit reached.");
}

export async function resolveFileKeeperIdm(items: FileInput[]): Promise<{
  links: Array<{ url: string; referer: string; cookie: string }>;
  resolved: number;
  failed: string[];
}> {
  if (!items.length || items.length > MAX_BATCH) {
    throw new Error(`Cloudflare resolution supports 1-${MAX_BATCH} FileKeeper files per request.`);
  }
  const links: Array<{ url: string; referer: string; cookie: string }> = [];
  const failed: string[] = [];
  for (const [index, item] of items.entries()) {
    try {
      const result = await resolveOne(item.pageUrl);
      links.push(result);
    } catch (error) {
      failed.push(`File ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!links.length) throw new Error(failed.join(" ") || "No FileKeeper links were resolved.");
  return { links, resolved: links.length, failed };
}

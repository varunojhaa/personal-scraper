/** Bounded HTTP requests shared by page scraping and metadata lookups. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

export function validateFetchUrl(raw: string): URL {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Use an HTTP or HTTPS URL without embedded credentials.");
  }
  return url;
}

/**
 * The timeout remains active while reading the body. Redirects are checked
 * individually, and binary downloads are cancelled rather than buffered.
 */
export async function fetchText(
  raw: string,
  init: RequestInit = {},
  textOnly = false,
): Promise<{ ok: boolean; status: number; finalUrl: string; text: string }> {
  let url = validateFetchUrl(raw);
  const { body: initialBody, ...options } = init;
  let method = init.method ?? "GET";
  let body = initialBody;
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const headers = new Headers(init.headers);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetch(url.href, {
      ...options,
      method,
      ...(body == null ? {} : { body }),
      headers,
      redirect: "manual",
      signal,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("The server returned a redirect without a destination.");
      if (redirects === MAX_REDIRECTS) throw new Error("Too many redirects.");
      const next = validateFetchUrl(new URL(location, url).href);
      if (next.origin !== url.origin) {
        headers.delete("authorization");
        headers.delete("cookie");
      }
      if (response.status === 303 || ([301, 302].includes(response.status) && method === "POST")) {
        method = "GET";
        body = undefined;
        headers.delete("content-type");
      }
      url = next;
      continue;
    }

    const result = { ok: response.ok, status: response.status, finalUrl: url.href };
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    if (textOnly && type && !type.includes("html") && !type.startsWith("text/")) {
      await response.body?.cancel();
      return { ...result, text: "" };
    }
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new Error("The server response is too large (maximum 4 MiB).");
    }

    const reader = response.body?.getReader();
    if (!reader) return { ...result, text: "" };
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error("The server response is too large (maximum 4 MiB).");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    return { ...result, text };
  }
  throw new Error("Too many redirects.");
}

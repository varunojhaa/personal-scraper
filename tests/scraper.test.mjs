import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import {
  extract,
  collectLinks,
  buildShellScript,
  buildIdmEf2,
  buildWget,
} from "../src/lib/pixeldrain-extract.ts";
import { scrapeUrl, resolvePasted, resolveDlc } from "../src/lib/scrape.server.ts";
import { fetchText, MAX_RESPONSE_BYTES } from "../src/lib/fetch.server.ts";

afterEach(() => mock.restoreAll());

function items(text) {
  const found = new Map();
  extract(text, "test", found);
  return [...found.values()];
}

function fakeFetch(handler) {
  const calls = [];
  mock.method(globalThis, "fetch", async (url, init) => {
    calls.push(String(url));
    return handler(String(url), init);
  });
  return calls;
}

test("extracts all supported hosts and deduplicates Pixeldrain API links", () => {
  const found = items(`
    https://pixeldrain.com/u/abcd1234
    https://pixeldrain.com/api/file/abcd1234?download
    https://pixeldrain.com/api/list/list1234/zip
    https://fileditchfiles.me/files/example.zip
    https://datanodes.to/abcd1234/example.zip
    https://filekeeper.net/abcd1234/fg-optional-bonus.bin
  `);
  assert.equal(found.length, 5);
  assert.equal(
    found.find((item) => item.kind === "list").directUrl,
    "https://pixeldrain.com/api/list/list1234/zip",
  );
  assert.equal(found.find((item) => item.host === "filekeeper").optional, true);
});

test("removed FuckingFast mirrors are neither extracted nor fetched", async () => {
  const urls = [
    "https://fuckingfast.co/abcd1234#fg-optional-bonus.bin",
    "https://fuckingfast.net/abcd1234",
    "https://www.fuckingfast.co/abcd1234",
  ];
  assert.deepEqual(items(urls.join("\n")), []);
  const source = "https://example.com/";
  const calls = fakeFetch((url) => {
    assert.equal(url, source, "Removed mirrors must not be fetched");
    return new Response(
      urls.map((link) => `<a href="${link}">mirror</a>`).join("\n") +
        '<a href="https://filekeeper.net/abcd1234/example.zip">FileKeeper</a>',
    );
  });
  for (const deep of [false, true]) {
    const result = await scrapeUrl(source, deep, 10);
    assert.deepEqual(
      result.items.map((item) => item.host),
      ["filekeeper"],
    );
  }
  for (const url of urls) {
    assert.deepEqual((await resolvePasted(url, "test")).items, []);
    assert.deepEqual((await scrapeUrl(url, true, 10)).items, []);
  }
  assert.deepEqual(calls, [source, source]);
});

test("ignores lookalike hostnames and preserves signed tunnel query strings", () => {
  assert.deepEqual(items("https://notpixeldrain.com/u/abcd1234"), []);
  const url = "https://cdn.dlproxy.uk/download/token?signature=abc%2Bdef&expires=123";
  assert.equal(items(url)[0].directUrl, url.replace("&", "&"));
});

test("collects absolute URLs even when the source label is not a URL", () => {
  assert.deepEqual(
    collectLinks('<a href="https://filecrypt.cc/Container/abcd.html">open</a>', "container.dlc"),
    ["https://filecrypt.cc/Container/abcd.html"],
  );
  assert.deepEqual(collectLinks('<a href="/download?a=1&b=2">go</a>', "https://example.com/page"), [
    "https://example.com/download?a=1&b=2",
  ]);
});

test("shallow scans queue protected links without fetching them", async () => {
  const calls = fakeFetch(
    () => new Response('<a href="https://filecrypt.cc/Container/abcd.html">open</a>'),
  );
  const result = await scrapeUrl("https://example.com/", false, 1);
  assert.deepEqual(result.protectedPages, ["https://filecrypt.cc/Container/abcd.html"]);
  assert.equal(calls.length, 1);
});

test("collects every FileKeeper part in a collapsed 186-link mirror with a one-page budget", async () => {
  // Layout and part counts observed on the Spider-Man 2 page. Synthetic file
  // codes keep this offline test independent of live download availability.
  const source = "https://fitgirl-repacks.site/marvels-spider-man-2/";
  const filenames = Array.from(
    { length: 133 },
    (_, i) => `example.part${String(i + 1).padStart(3, "0")}.rar`,
  );
  for (const [language, count] of Object.entries({
    arabic: 4,
    brazilian: 4,
    french: 5,
    german: 5,
    italian: 5,
    japanese: 5,
    mexican: 5,
    polish: 5,
    portuguese: 4,
    russian: 5,
    spanish: 5,
  })) {
    filenames.push(
      ...Array.from({ length: count }, (_, i) => `fg-optional-${language}-vo.part${i + 1}.rar`),
    );
  }
  filenames.push("fg-optional-bonus-soundtrack.bin");
  assert.equal(filenames.length, 186);
  const urls = filenames.map((name, i) => `https://filekeeper.net/test${i + 1000}/${name}`);
  const anchors = urls.map((url, i) => `<a href="${url}">${filenames[i]}</a><br />`).join("\n");
  const html = `<div class="su-spoiler su-spoiler-closed dlinks">
    <div class="su-spoiler-title">Click to show direct links</div>
    <div class="su-spoiler-content">${anchors}</div>
  </div>`;
  const calls = fakeFetch((url) => {
    assert.equal(url, source, "Collecting links must not fetch individual file pages");
    return new Response(html);
  });

  for (const deep of [false, true]) {
    const result = await scrapeUrl(source, deep, 1);
    assert.deepEqual(result.pagesScanned, [source]);
    assert.deepEqual(
      result.items.map((item) => item.pageUrl),
      urls,
    );
    assert.deepEqual(
      result.items.map((item) => item.filename),
      filenames,
    );
    assert.equal(result.items.filter((item) => !item.optional).length, 133);
    assert.equal(result.items.filter((item) => item.optional).length, 53);
    assert.ok(result.items.every((item) => item.host === "filekeeper" && item.tool === "wget"));
    const script = buildShellScript(result.items);
    assert.equal(script.match(/python3 -c /g)?.length, 186);
    for (const url of urls) assert.ok(script.includes(`'${url}'`));
  }
  assert.deepEqual(calls, [source, source]);
});

test("failed deep requests count toward maxPages and the root is not fetched twice", async () => {
  const calls = fakeFetch((url) =>
    url === "https://example.com/"
      ? new Response(
          '<a href="/">home</a><a href="/one">1</a><a href="/two">2</a><a href="/three">3</a>',
        )
      : new Response("unavailable", { status: 503 }),
  );
  const result = await scrapeUrl("https://example.com/", true, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(result.pagesScanned, ["https://example.com/"]);
});

test("metadata marks optional files and direct host pages are not downloaded", async () => {
  const calls = fakeFetch(() => Response.json({ name: "fg-optional-bonus.bin" }));
  const result = await scrapeUrl("https://pixeldrain.com/u/abcd1234", false, 1);
  assert.equal(result.items[0].optional, true);
  assert.deepEqual(calls, ["https://pixeldrain.com/api/file/abcd1234/info"]);
});

test("metadata failure preserves downloadable links", async () => {
  fakeFetch(() => {
    throw new Error("offline");
  });
  const result = await resolvePasted("https://pixeldrain.com/u/abcd1234", "");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].filename, undefined);
});

test("pasted HTML preserves its protected-link queue", async () => {
  const calls = fakeFetch(() => {
    throw new Error("should not fetch");
  });
  const result = await resolvePasted(
    '<a href="https://filecrypt.cc/Container/abcd.html">open</a>',
    "",
  );
  assert.equal(result.protectedPages.length, 1);
  assert.equal(calls.length, 0);
});

test("pasted page fetch errors are reported instead of empty success", async () => {
  fakeFetch(() => new Response("missing", { status: 404 }));
  await assert.rejects(resolvePasted("https://example.com/missing", ""), /HTTP 404/);
});

test("DLC following bounds failed requests and deduplicates service links", async () => {
  const links = Array.from({ length: 30 }, (_, i) => `https://example.com/${i}`);
  const calls = fakeFetch((url) =>
    url === "https://dcrypt.it/decrypt/paste"
      ? Response.json({ success: { links: [...links, ...links, null] } })
      : new Response("unavailable", { status: 503 }),
  );
  await resolveDlc("dummy-container", "links.dlc", true);
  assert.equal(calls.length, 21);
});

test("redirected POST requests become GET without retaining their body", async () => {
  fakeFetch((url, init) => {
    assert.ok(init.signal instanceof AbortSignal);
    if (url.endsWith("/start"))
      return new Response(null, { status: 303, headers: { location: "/end" } });
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    return new Response("finished");
  });
  const result = await fetchText("https://example.com/start", { method: "POST", body: "data" });
  assert.equal(result.text, "finished");
  assert.equal(result.finalUrl, "https://example.com/end");
});

test("invalid protocols, credentials, and redirect loops are rejected", async () => {
  const calls = fakeFetch(
    () => new Response(null, { status: 302, headers: { location: "/loop" } }),
  );
  await assert.rejects(fetchText("file:///secret"), /HTTP or HTTPS/);
  await assert.rejects(fetchText("https://user:password@example.com"), /credentials/);
  assert.equal(calls.length, 0);
  await assert.rejects(fetchText("https://example.com/loop"), /Too many redirects/);
  assert.equal(calls.length, 6);
});

test("redirects cannot switch to non-HTTP URLs", async () => {
  fakeFetch(() => new Response(null, { status: 302, headers: { location: "file:///secret" } }));
  await assert.rejects(fetchText("https://example.com/"), /HTTP or HTTPS/);
});

test("large declared and streamed bodies are rejected", async () => {
  fakeFetch(
    () => new Response("small", { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }),
  );
  await assert.rejects(fetchText("https://example.com/"), /too large/);
  mock.restoreAll();
  fakeFetch(() => new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1)));
  await assert.rejects(fetchText("https://example.com/"), /too large/);
});

test("binary downloads are cancelled instead of buffered as pages", async () => {
  let cancelled = false;
  fakeFetch(
    () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "application/octet-stream" } },
      ),
  );
  const result = await fetchText("https://example.com/file", {}, true);
  assert.equal(result.text, "");
  assert.equal(cancelled, true);
});

test("exports sanitize filenames, quote apostrophes, and require output plus completion marker", () => {
  const item = { ...items("https://pixeldrain.com/u/abcd1234")[0], filename: "../a'b.zip" };
  const script = buildShellScript([item]);
  assert.ok(!script.includes("../"));
  assert.ok(script.includes("a'\\''b.zip"));
  assert.ok(script.includes(".done"));
  assert.ok(script.includes("failed=$((failed + 1))"));
  assert.ok(script.includes("exit 1"));
  assert.equal(buildShellScript([]), "");
  assert.equal(buildWget([]), "");
  const ef2 = buildIdmEf2([{ ...item, pageUrl: "https://example.com/\r\ninjected: bad" }]);
  assert.ok(!ef2.includes("\ninjected:"));
});

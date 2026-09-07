import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  buildWget,
  buildFileKeeperIdmScript,
  buildIdmList,
  buildIdmEf2,
  extract,
} from "../src/lib/pixeldrain-extract.ts";

test("generated FileKeeper Python resolves countdown pages and enforces safeguards", () => {
  const candidates =
    process.platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"];
  const python = candidates.find((candidate) => spawnSync(candidate, ["--version"]).status === 0);
  assert.ok(python, "Python 3 is required to test the generated FileKeeper resolver");
  const found = new Map();
  extract("https://filekeeper.net/example12345/example.mkv", "test", found);
  const command = buildWget([...found.values()]);
  const result = spawnSync(
    python,
    [fileURLToPath(new URL("./filekeeper-resolver.py", import.meta.url))],
    {
      input: JSON.stringify({ command, idm: buildFileKeeperIdmScript([...found.values()]) }),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
});

test("IDM lists exclude FileKeeper HTML pages but preserve signed downloads", () => {
  const found = new Map();
  extract("https://filekeeper.net/example12345/example.mkv", "test", found);
  const item = [...found.values()][0];
  assert.equal(buildIdmList([item]), "");
  assert.equal(buildIdmEf2([item]), "");
  assert.equal(buildFileKeeperIdmScript([]), "");
  const ef2Script = buildFileKeeperIdmScript([item], "ef2");
  assert.ok(ef2Script.includes('default_output="filekeeper-idm-%s.ef2"'));
  assert.ok(ef2Script.includes("export_ef2=True"));
  assert.ok(ef2Script.includes('record="<"+single_line(link)+"\\r\\n'));
  assert.ok(ef2Script.includes('record += "\\r\\n>\\r\\n"'));
  const directUrl = "https://cdn.dlproxy.uk/download/example?signature=abc%2Bdef&expires=123";
  const direct = { ...item, directUrl };
  assert.equal(buildIdmList([direct]), directUrl);
  const directEf2 = buildIdmEf2([direct]);
  assert.ok(directEf2.startsWith(`<${directUrl}\r\n`));
  assert.ok(directEf2.includes("referer: "));
  assert.ok(
    directEf2.includes(
      "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    ),
  );
  assert.ok(directEf2.endsWith("\r\n>"));
  assert.equal(directEf2.match(/>/g)?.length, 1);
  assert.equal(
    buildIdmList([{ ...item, directUrl: "https://dlproxy.uk.evil.example/download/a" }]),
    "",
  );
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  buildWget,
  buildFileKeeperIdmScript,
  buildIdmList,
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

test("IDM TXT lists exclude FileKeeper HTML pages but preserve signed downloads", () => {
  const found = new Map();
  extract("https://filekeeper.net/example12345/example.mkv", "test", found);
  const item = [...found.values()][0];
  assert.equal(buildIdmList([item]), "");
  assert.equal(buildFileKeeperIdmScript([]), "");
  const txtScript = buildFileKeeperIdmScript([item]);
  assert.ok(txtScript.includes('default_output="filekeeper-idm-%s.txt"'));
  assert.ok(!txtScript.includes(".ef2"));
  assert.ok(!txtScript.includes("export_ef2"));
  assert.ok(txtScript.includes('output.write(single_line(link)+"\\r\\n")'));
  const directUrl = "https://cdn.dlproxy.uk/download/example?signature=abc%2Bdef&expires=123";
  const direct = { ...item, directUrl };
  assert.equal(buildIdmList([direct]), directUrl);
  assert.equal(
    buildIdmList([{ ...item, directUrl: "https://dlproxy.uk.evil.example/download/a" }]),
    "",
  );
});

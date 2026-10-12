import assert from "node:assert/strict";
import { test } from "node:test";
import { exportName } from "../src/lib/pixeldrain-extract.ts";

const file = (filename) => ({
  id: filename,
  kind: "file",
  host: "pixeldrain",
  pageUrl: "",
  directUrl: "",
  foundOn: "https://fileditchfiles.st/beta38/x",
  filename,
  tool: "wget",
});

test("single-file exports keep only the title, dropping episode codes", () => {
  const items = [file("Dive.into.You.S01E02.1080p.DSNP.WEB-DL.AAC2.0.H.264-MrHulk.mkv")];
  assert.equal(exportName(items, "https://fileditchfiles.st", "sh"), "dive-into-you.sh");
});

test("multi-file exports use the common title and a plain count", () => {
  const items = ["S01E01", "S01E02", "S01E03"].map((ep) =>
    file(`Dive.into.You.${ep}.1080p.DSNP.WEB-DL.AAC2.0.H.264-MrHulk.mkv`),
  );
  assert.equal(exportName(items, "https://fileditchfiles.st", "sh"), "dive-into-you-3.sh");
});

test("a title that ends in a number keeps that number", () => {
  const items = [file("Marvels.Spider.Man.2.1080p.PSNP.WEB-DL.DDP5.1.Atmos.H.264-FLUX.mkv")];
  assert.equal(exportName(items, "https://fileditchfiles.st", "sh"), "marvels-spider-man-2.sh");
});

test("export names stay short and never keep quality or codec tags", () => {
  const items = [file("Dive.into.You.S01E02.1080p.DSNP.WEB-DL.AAC2.0.H.264-MrHulk.mkv")];
  const name = exportName(items, "https://fileditchfiles.st", "sh");
  assert.ok(name.length <= 26, `name too long: ${name}`);
  assert.ok(!/1080p|s01e02|mrhulk/i.test(name), `name keeps release tags: ${name}`);
});

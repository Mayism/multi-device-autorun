import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import { createZip } from "./zip.mjs";
import { archiveCases } from "./archive-cases.mjs";
import { filterGeneratedArtifactPatch } from "./generated-artifact-filter.mjs";

function unzip(buffer) {
  const bytes = Buffer.from(buffer);
  const files = {};
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18);
    const nameSize = bytes.readUInt16LE(offset + 26);
    const extraSize = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameSize).toString();
    const start = offset + 30 + nameSize + extraSize;
    files[name] = inflateRawSync(bytes.subarray(start, start + size)).toString();
    offset = start + size;
  }
  return files;
}

test("case ZIP includes onemulti reports, evidence and scripts but not caches or business patch noise", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-zip-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const names = [
    "base/.onemulti/decisions.json", "base/.onemulti/adaptation-summary.html",
    "base/.onemulti/evidence/B01/shot.png", "base/.onemulti/scripts/check.py",
    "task/.onemulti/history/task1/report.html", "base/src/page.ets",
  ];
  const excluded = [
    "base/.onemulti/evidence/tmp/data.json", "base/.onemulti/scripts/__pycache__/check.pyc",
    "base/.onemulti/cache.pyc", "base/build/app.hap", "base/node_modules/index.js",
  ];
  for (const name of [...names, ...excluded]) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), name);
  }
  const archive = unzip(await createZip([{ dirPath: root }]));
  assert.deepEqual(Object.keys(archive).sort(), names.sort());
  for (const name of names) assert.equal(archive[name], name);
  const patch = "diff --git a/.onemulti/decisions.json b/.onemulti/decisions.json\n+private\ndiff --git a/src/page.ets b/src/page.ets\n+code\n";
  assert.equal(filterGeneratedArtifactPatch(patch), "diff --git a/src/page.ets b/src/page.ets\n+code\n");
});

test("manual local repack refreshes ZIP without writing upload results", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-repack-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "Case/base/.onemulti"), { recursive: true });
  await fs.writeFile(path.join(root, "Case/base/.onemulti/report.html"), "report");
  await fs.mkdir(path.join(root, "Case/generate"), { recursive: true });
  await fs.mkdir(path.join(root, "Case/.ohostest-runs/run-1"), { recursive: true });
  for (const name of ["result.json", "state.json", "session.json", "generate/input.txt", "generate/last-message.json", "generate/skill-runtime.json", "generate/output.txt", "generate/final-message.json"]) {
    await fs.writeFile(path.join(root, "Case", name), "temporary");
  }
  await fs.writeFile(path.join(root, "Case/.ohostest-runs/run-1/result.json"), "runner result");
  await fs.writeFile(path.join(root, "Case/Case_batch.zip"), "old zip");
  const archived = await archiveCases({ batchRoot: root, summary: { batchId: "batch", results: [{ case: "Case", status: "completed" }] } });
  assert.deepEqual(archived, [path.join(root, "Case/Case_batch.zip")]);
  await assert.rejects(fs.access(path.join(root, "upload-results.json")));
  const archive = unzip(await fs.readFile(path.join(root, "Case/Case_batch.zip")));
  assert.equal(archive["base/.onemulti/report.html"], "report");
  assert.equal(archive[".ohostest-runs/run-1/result.json"], "runner result");
  for (const name of ["result.json", "state.json", "session.json", "generate/input.txt", "generate/last-message.json", "generate/skill-runtime.json", "generate/output.txt", "generate/final-message.json"]) {
    assert.equal(archive[name], undefined);
  }
  assert.equal(archive["Case_batch.zip"], undefined);
});

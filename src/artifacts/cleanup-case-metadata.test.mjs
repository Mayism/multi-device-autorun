import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cleanupCaseMetadata } from "./cleanup-case-metadata.mjs";

test("summary 落盘后只清理指定用例顶层的运行期 JSON", async (t) => {
  const batchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "case-metadata-"));
  t.after(() => fs.rm(batchRoot, { recursive: true, force: true }));
  const caseDir = path.join(batchRoot, "Case_A");
  const runnerDir = path.join(caseDir, ".ohostest-runs", "run-1");
  await fs.mkdir(runnerDir, { recursive: true });
  for (const name of ["result.json", "state.json", "session.json"]) {
    await fs.writeFile(path.join(caseDir, name), "{}\n");
  }
  await fs.mkdir(path.join(caseDir, "generate"));
  for (const name of ["input.txt", "last-message.json", "skill-runtime.json", "output.txt", "final-message.json"]) {
    await fs.writeFile(path.join(caseDir, "generate", name), "temporary");
  }
  await fs.writeFile(path.join(runnerDir, "result.json"), "{}\n");
  await fs.writeFile(path.join(caseDir, "keep.json"), "{}\n");
  await fs.writeFile(path.join(batchRoot, "summary.json"), "{}\n");

  const failures = await cleanupCaseMetadata({ batchRoot, summary: { results: [{ case: "Case A" }] } });

  assert.deepEqual(failures, []);
  for (const name of ["result.json", "state.json", "session.json"]) {
    await assert.rejects(fs.access(path.join(caseDir, name)), { code: "ENOENT" });
  }
  for (const name of ["input.txt", "last-message.json", "skill-runtime.json", "output.txt", "final-message.json"]) {
    await assert.rejects(fs.access(path.join(caseDir, "generate", name)), { code: "ENOENT" });
  }
  await fs.access(path.join(runnerDir, "result.json"));
  await fs.access(path.join(caseDir, "keep.json"));
  await fs.access(path.join(batchRoot, "summary.json"));
});

test("summary.json 尚未落盘时不清理运行期文件", async (t) => {
  const batchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "case-metadata-"));
  t.after(() => fs.rm(batchRoot, { recursive: true, force: true }));
  const caseDir = path.join(batchRoot, "CaseA");
  await fs.mkdir(caseDir);
  await fs.writeFile(path.join(caseDir, "result.json"), "{}\n");

  await assert.rejects(cleanupCaseMetadata({ batchRoot, summary: { results: [{ case: "CaseA" }] } }), { code: "ENOENT" });
  await fs.access(path.join(caseDir, "result.json"));
});

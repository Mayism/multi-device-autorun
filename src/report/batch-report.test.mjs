import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeBatchReport } from "./batch-report.mjs";

test("batch report keeps local ZIP and does not create upload results", async (t) => {
  const batchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-batch-report-"));
  t.after(() => fs.rm(batchRoot, { recursive: true, force: true }));
  const caseDir = path.join(batchRoot, "CaseA");
  await fs.mkdir(caseDir);
  await fs.writeFile(path.join(caseDir, "result.json"), JSON.stringify({ case: "CaseA", status: "completed" }));
  const summary = {
    batchId: "batch-1", status: "completed", total: 1, completed: 1, failed: 0,
    results: [{ case: "CaseA", status: "completed", resultPath: path.join(caseDir, "result.json") }],
  };
  await writeBatchReport({ batchRoot, summary });
  assert.ok((await fs.stat(path.join(caseDir, "CaseA_batch-1.zip"))).size > 0);
  assert.ok((await fs.stat(path.join(batchRoot, "overview.html"))).size > 0);
  await assert.rejects(fs.access(path.join(batchRoot, "upload-results.json")));
});

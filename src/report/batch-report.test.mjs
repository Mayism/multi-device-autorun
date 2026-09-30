import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeBatchReport } from "./batch-report.mjs";

test("batch report counts agent events and device tests from saved run data", async () => {
  const batchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-batch-report-"));
  try {
    const messagesPath = path.join(batchRoot, "all-messages.json");
    const runnerPath = path.join(batchRoot, "runner.json");
    await fs.writeFile(messagesPath, JSON.stringify([{
      sessionId: "s1",
      messages: [{ info: { id: "m1", role: "assistant", tokens: { input: 3 } }, parts: [
        { type: "tool", callID: "t1" }, { type: "tool", callID: "t1" },
      ] }],
    }]));
    await fs.writeFile(runnerPath, JSON.stringify({ runs: { swe: { status: "completed", devices: [
      { id: "device-1", status: "completed", testsRun: 2, passes: 1, failures: 1 },
    ] } } }));
    const summary = {
      batchId: "batch-1", status: "completed_with_failures", agent: "build", total: 1,
      completed: 0, failed: 1, results: [{
        case: "中文用例", status: "failed", tokenUsage: { input: 3, output: 2, total: 5 },
        logs: { messagesPath }, ohosTest: { status: "completed", resultPath: runnerPath },
      }],
    };
    const { jsonPath } = await writeBatchReport({ batchRoot, summary, uploadConfig: { enabled: false } });
    const report = JSON.parse(await fs.readFile(jsonPath, "utf8"));
    assert.equal(report.agent.modelCalls, 1);
    assert.equal(report.agent.toolCalls, 1);
    assert.equal(report.agent.totalTokens, 5);
    assert.equal(report.agent.cases[0].case, "中文用例");
    assert.deepEqual([report.ohosTest.testsRun, report.ohosTest.passes, report.ohosTest.failures], [2, 1, 1]);
    assert.equal(report.ohosTest.caseResults[0].runnerOutputAvailable, true);
  } finally {
    await fs.rm(batchRoot, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeAgentComparisonReport } from "./agent-comparison-report.mjs";

async function target(root, id, modelId = "glm-5.2") {
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  const summary = {
    batchId: "20260827143000", agent: id, providerId: "zhipuai-coding-plan", modelId,
    status: "completed", total: 1, completed: 1, failed: 0,
    tokenUsage: { total: 10 }, results: [{ case: "CaseA", status: "completed", elapsedSec: 2, tokenUsage: { total: 10 } }],
  };
  const report = {
    agent: { type: id, providerId: "zhipuai-coding-plan", modelId, modelCalls: 1, toolCalls: 2, cases: [{ case: "CaseA", status: "completed" }] },
    ohosTest: { testsRun: 1, passes: 1, failures: 0, errors: 0, caseResults: [{ case: "CaseA", status: "completed", run: { devices: [{ passes: 1 }] } }] },
    whitebox: { averageScore: 90, cases: [{ case: "CaseA", totalScore: 90 }] },
  };
  await fs.writeFile(path.join(dir, "summary.json"), JSON.stringify(summary));
  await fs.writeFile(path.join(dir, "report.json"), JSON.stringify(report));
  await fs.writeFile(path.join(dir, "environment.json"), JSON.stringify({
    generationModel: { providerId: "zhipuai-coding-plan", modelId, configFingerprint: "same-fingerprint" },
  }));
  return { id, label: id, targetRoot: dir };
}

test("single target writes only root overview", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-overview-"));
  const a = await target(root, "harmonybot");
  const result = await writeAgentComparisonReport({ runRoot: root, runId: "20260827143000", generationModel: { providerId: "zhipuai-coding-plan", modelId: "glm-5.2" }, targets: [a] });
  assert.equal(result.comparisonPath, "");
  assert.match(await fs.readFile(result.overviewPath, "utf8"), /harmonybot/);
});

test("failed targets still validate the preflight model from environment manifests", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-comparison-failed-"));
  const targets = [];
  for (const id of ["harmonybot", "software-engineering"]) {
    const dir = path.join(root, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "environment.json"), JSON.stringify({
      generationModel: { providerId: "zhipuai-coding-plan", modelId: "glm-5.2", configFingerprint: "same" },
    }));
    targets.push({ id, targetRoot: dir, error: "no cases" });
  }
  const result = await writeAgentComparisonReport({ runRoot: root, runId: "20260827143000", generationModel: { providerId: "zhipuai-coding-plan", modelId: "glm-5.2" }, targets });
  assert.equal(result.comparison.sameModelValidated, true);
});

test("multiple targets write comparison and validate exact same model", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-comparison-"));
  const targets = [await target(root, "harmonybot"), await target(root, "software-engineering")];
  const result = await writeAgentComparisonReport({ runRoot: root, runId: "20260827143000", generationModel: { providerId: "zhipuai-coding-plan", modelId: "glm-5.2" }, targets });
  assert.equal(result.comparison.sameModelValidated, true);
  assert.equal(result.comparison.targetCount, 2);
  assert.ok(await fs.stat(result.comparisonPath));
});

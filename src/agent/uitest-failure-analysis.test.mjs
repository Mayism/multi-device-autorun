import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzeUitestFailures,
  collectUitestFailures,
  failureIdentity,
  normalizeFailureAnalyses,
} from "./uitest-failure-analysis.mjs";

const failedRunnerResult = {
  runs: {
    swe: {
      devices: [{
        id: "emulator-1",
        profile: "phone",
        suiteResults: [{
          suiteClass: "EntryAbilityTest",
          testCases: [{
            name: "shows_title",
            status: "failed",
            statusCode: 1,
            message: "expected title",
            stack: "at EntryAbilityTest.ets:42",
          }, {
            name: "opens_page",
            status: "passed",
            statusCode: 0,
          }],
        }],
      }],
    },
  },
};

test("collectUitestFailures 只提取失败项并生成稳定 ID", () => {
  const failures = collectUitestFailures(failedRunnerResult);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].name, "shows_title");
  assert.equal(failures[0].failureId, failureIdentity(failures[0]));
});

test("normalizeFailureAnalyses 忽略未知 ID 并规范枚举", () => {
  const failures = collectUitestFailures(failedRunnerResult);
  const analyses = normalizeFailureAnalyses({
    analyses: [
      { failureId: "unknown", summary: "wrong" },
      { failureId: failures[0].failureId, category: "other", summary: "页面未渲染标题", confidence: "certain" },
    ],
  }, failures);
  assert.deepEqual(analyses, [{
    failureId: failures[0].failureId,
    category: "inconclusive",
    summary: "页面未渲染标题",
    uxReason: "页面未渲染标题",
    expectedBehavior: "",
    actualBehavior: "",
    technicalCause: "",
    evidence: [],
    confidence: "low",
    suggestion: "",
  }]);
});

test("analyzeUitestFailures 保存独立证据和结构化分析结果", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uitest-analysis-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runDir = path.join(root, "case-run");
  const sourceDir = path.join(runDir, "work");
  const runnerDir = path.join(runDir, ".ohostest-runs", "run-1");
  await fs.mkdir(path.join(sourceDir, "entry", "src"), { recursive: true });
  await fs.mkdir(runnerDir, { recursive: true });
  await fs.writeFile(path.join(root, "PROMPT.md"), "显示标题", "utf8");
  await fs.writeFile(path.join(root, "metadata.json"), "{}", "utf8");
  await fs.writeFile(path.join(root, "test.patch"), "+ test", "utf8");
  await fs.writeFile(path.join(runDir, "changes.patch"), "+++ b/entry/src/Page.ets\n+Text('Wrong')", "utf8");
  await fs.writeFile(path.join(sourceDir, "entry", "src", "Page.ets"), "Text('Wrong')", "utf8");
  await fs.writeFile(path.join(runnerDir, "result.json"), JSON.stringify(failedRunnerResult), "utf8");
  await fs.writeFile(path.join(runnerDir, "commands.jsonl"), '{"stderr":"assert failed"}\n', "utf8");

  let submittedPrompt = "";
  const failureId = collectUitestFailures(failedRunnerResult)[0].failureId;
  const result = await analyzeUitestFailures({
    client: {
      async createSession(directory) {
        assert.equal(directory, path.join(runDir, "failure-analysis"));
        return { id: "analysis-session" };
      },
    },
    model: { providerId: "provider", modelId: "model" },
    caseInfo: { name: "CaseA", promptPath: path.join(root, "PROMPT.md") },
    agentResult: {
      case: "CaseA",
      resultPath: path.join(runDir, "result.json"),
      patchPath: path.join(runDir, "changes.patch"),
      projectDir: sourceDir,
    },
    ohosTest: {
      resultPath: path.join(runnerDir, "result.json"),
      outputDir: runnerDir,
      metadataPath: path.join(root, "metadata.json"),
      testPatchPath: path.join(root, "test.patch"),
      workDir: sourceDir,
    },
    sessionRunner: async ({ payload }) => {
      submittedPrompt = payload.parts[0].text;
      return { output: JSON.stringify({ analyses: [{
        failureId,
        category: "implementation_defect",
        uxReason: "用户看到错误标题，无法确认当前页面功能",
        expectedBehavior: "页面显示新标题",
        actualBehavior: "页面仍显示旧标题",
        technicalCause: "实现显示了错误标题",
        evidence: ["Page.ets 使用 Wrong"],
        confidence: "high",
        suggestion: "修正标题",
      }] }) };
    },
  });

  assert.equal(result.status, "completed");
  assert.match(submittedPrompt, /Text\('Wrong'\)/);
  const saved = JSON.parse(await fs.readFile(result.resultPath, "utf8"));
  assert.equal(saved.analyses[0].failureId, failureId);
  assert.equal(saved.analyses[0].summary, "用户看到错误标题，无法确认当前页面功能");
  assert.equal(saved.analyses[0].technicalCause, "实现显示了错误标题");
});

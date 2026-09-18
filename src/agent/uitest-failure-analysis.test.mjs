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
  selectDiagnosticAgent,
} from "./uitest-failure-analysis.mjs";
import { buildFailureInteractionContext } from "./uitest-interaction-context.mjs";

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

test("诊断 Agent 按 build、general、当前 Agent 的顺序选择", () => {
  assert.equal(selectDiagnosticAgent({ agent: { build: {}, general: {}, current: {} } }, "current"), "build");
  assert.equal(selectDiagnosticAgent({ agent: { general: {}, current: {} } }, "current"), "general");
  assert.equal(selectDiagnosticAgent({ agent: { current: {} } }, "current"), "current");
});

test("从失败测试解析 ID、目标文案和未执行断言", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uitest-interaction-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const testFile = path.join(project, "products/default/src/ohosTest/ets/test/FullScreenTest.ets");
  const constantsFile = path.join(project, "products/default/src/main/ets/constants/Constants.ets");
  const pageFile = path.join(project, "products/default/src/main/ets/pages/Index.ets");
  const resourceFile = path.join(project, "products/default/src/main/resources/base/element/string.json");
  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await fs.mkdir(path.dirname(constantsFile), { recursive: true });
  await fs.mkdir(path.dirname(pageFile), { recursive: true });
  await fs.mkdir(path.dirname(resourceFile), { recursive: true });
  await fs.writeFile(testFile, [
    "async function enterFullScreenPage(driver) {",
    "  await driver.waitForComponent(ON.type('Navigation'), 5000);",
    "  await (await driver.findComponent(ON.id('FullScreen'))).click();",
    "}",
    "it('should_hide_status_bar', 0, async () => {",
    "  await enterFullScreenPage(driver);",
    "  expect(statusBarRect.height).assertEqual(0);",
    "});",
  ].join("\n"), "utf8");
  await fs.writeFile(constantsFile, [
    "export const ROUTES = [",
    "{ title: $r('app.string.other_title'), to: 'Other' },",
    "{",
    "  title: $r('app.string.full_screen_title'),",
    "  to: 'FullScreen'",
    "}];",
  ].join("\n"), "utf8");
  await fs.writeFile(pageFile, "Text(route.title).id(route.to).onClick(() => {})\n", "utf8");
  await fs.writeFile(resourceFile, JSON.stringify({
    string: [
      { name: "other_title", value: "其他入口" },
      { name: "full_screen_title", value: "避让区隐藏" },
    ],
  }), "utf8");
  const failure = {
    failureId: "failure-1",
    name: "should_hide_status_bar",
    message: "Cannot read property click of null",
    stack: "at enterFullScreenPage default (products/default/src/ohosTest/ets/test/FullScreenTest.ets:3:59)",
  };

  const result = await buildFailureInteractionContext([failure], {
    projectRoots: [project],
    testRoots: [project],
  });

  const interaction = result.failures[0].interaction;
  assert.equal(interaction.phase, "前置导航");
  assert.deepEqual(interaction.locator, { type: "id", value: "FullScreen" });
  assert.equal(interaction.target.componentType, "Text");
  assert.equal(interaction.target.displayText, "避让区隐藏");
  assert.equal(interaction.result.returnedValue, "null");
  assert.equal(interaction.assertion.executed, false);
  assert.match(interaction.assertion.expression, /statusBarRect\.height/);
  assert.match(result.fallbackAnalyses[0].summary, /ID“FullScreen”/);
  assert.match(result.fallbackAnalyses[0].summary, /“避让区隐藏”/);
  assert.match(result.fallbackAnalyses[0].summary, /状态栏高度断言没有执行/);
  assert.match(result.fallbackAnalyses[0].summary, /不能证明状态栏隐藏功能存在问题/);

  const caseRunDir = path.join(root, "case-run");
  const runnerDir = path.join(caseRunDir, "runner");
  await fs.mkdir(runnerDir, { recursive: true });
  const runnerResult = {
    runs: { swe: { devices: [{
      id: "emulator-1",
      profile: "phone",
      suiteResults: [{ suiteClass: "FullScreenTest", testCases: [{
        name: failure.name,
        status: "failed",
        statusCode: -1,
        message: failure.message,
        stack: failure.stack,
      }] }],
    }] } },
  };
  const runnerResultPath = path.join(runnerDir, "result.json");
  await fs.writeFile(runnerResultPath, JSON.stringify(runnerResult), "utf8");
  const analyzed = await analyzeUitestFailures({
    client: {
      async createSession() { return { id: "failure-analysis-session" }; },
      async getConfig() { return { agent: { build: {} } }; },
    },
    model: { providerId: "provider", modelId: "model" },
    caseInfo: { name: "CaseFullScreen" },
    agentResult: {
      case: "CaseFullScreen",
      agent: "harmonyos-multi-device",
      resultPath: path.join(caseRunDir, "result.json"),
      projectDir: project,
    },
    ohosTest: {
      resultPath: runnerResultPath,
      outputDir: runnerDir,
      workDir: project,
    },
    sessionRunner: async () => { throw new Error("model unavailable"); },
  });
  assert.equal(analyzed.status, "partial");
  const saved = JSON.parse(await fs.readFile(analyzed.resultPath, "utf8"));
  assert.equal(saved.status, "partial");
  assert.equal(saved.model.agent, "build");
  assert.equal(saved.analyses[0].interaction.locator.value, "FullScreen");
  assert.match(saved.analyses[0].summary, /避让区隐藏/);
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
      async getConfig() {
        return { agent: { build: {}, general: {}, "harmonyos-multi-device": {} } };
      },
      async createSession(directory) {
        assert.equal(directory, path.join(runDir, "failure-analysis"));
        return { id: "analysis-session" };
      },
    },
    model: { providerId: "provider", modelId: "model" },
    caseInfo: { name: "CaseA", promptPath: path.join(root, "PROMPT.md") },
    agentResult: {
      case: "CaseA",
      agent: "harmonyos-multi-device",
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
      assert.equal(payload.agent, "build");
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

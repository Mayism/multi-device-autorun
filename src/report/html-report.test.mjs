import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { failureIdentity } from "../agent/uitest-failure-analysis.mjs";
import { writeHtmlReport } from "./html-report.mjs";

test("详情页优先展示分析根因并折叠原始调用栈", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "html-failure-analysis-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runnerPath = path.join(root, "runner.json");
  const analysisPath = path.join(root, "failure-analysis.json");
  const failure = {
    deviceId: "emulator-1",
    deviceProfile: "phone",
    suite: "EntryAbilityTest",
    name: "shows_title",
    message: "expected title",
    stack: "at EntryAbilityTest.ets:42",
  };
  await fs.writeFile(runnerPath, JSON.stringify({
    runs: { swe: { devices: [{
      id: failure.deviceId,
      profile: failure.deviceProfile,
      suiteResults: [{ suiteClass: failure.suite, testCases: [{
        name: failure.name,
        status: "failed",
        statusCode: 1,
        message: failure.message,
        stack: failure.stack,
      }] }],
    }] } },
  }), "utf8");
  await fs.writeFile(analysisPath, JSON.stringify({
    status: "completed",
    analyses: [{
      failureId: failureIdentity(failure),
      category: "implementation_defect",
      summary: "页面标题未按需求更新",
      evidence: ["Page.ets 仍显示旧标题"],
      confidence: "high",
      suggestion: "修改标题资源",
    }],
  }), "utf8");
  const summary = {
    batchId: "batch-1",
    results: [{
      case: "CaseA",
      status: "failed",
      ohosTest: {
        status: "failed",
        resultPath: runnerPath,
        failureAnalysis: { status: "completed", resultPath: analysisPath },
      },
    }],
  };

  await writeHtmlReport({ batchRoot: root, summary });
  const html = await fs.readFile(path.join(root, "subpage", "CaseA.html"), "utf8");
  assert.match(html, /页面标题未按需求更新/);
  assert.match(html, /实现缺陷/);
  assert.match(html, /原始错误与调用栈（技术详情）/);
  assert.match(html, /EntryAbilityTest\.ets:42/);
});

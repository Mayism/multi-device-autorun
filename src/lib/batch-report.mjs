import fs from "node:fs/promises";
import path from "node:path";

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function status(value) {
  return text(value).trim() || "not_started";
}

function tokenUsage(value = {}) {
  return { input: number(value.input), output: number(value.output), total: number(value.total) };
}

function compileUsage(value = {}) {
  return {
    attempts: number(value.attempts),
    succeeded: number(value.succeeded),
    failed: number(value.failed),
    interrupted: number(value.interrupted),
    running: number(value.running),
  };
}

function addMetrics(items, field) {
  return items.reduce((total, item) => total + number(item[field]), 0);
}

function durationSeconds(value) {
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? Math.round(milliseconds / 1000) : 0;
}

function durationText(seconds) {
  const total = number(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(rest).padStart(2, "0")}s`;
  if (minutes) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  return `${rest}s`;
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function table(headers, rows) {
  if (!rows.length) return "无";
  return [
    `| ${headers.map(markdownCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`),
  ].join("\n");
}

async function readJson(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function agentEventCounts(messagesPath) {
  const sessions = await readJson(messagesPath);
  if (!Array.isArray(sessions)) return { modelCalls: 0, toolCalls: 0, available: false };
  const modelMessages = new Set();
  const toolCalls = new Set();
  for (const session of sessions) {
    const sessionId = text(session?.sessionId);
    for (let messageIndex = 0; messageIndex < (session?.messages || []).length; messageIndex += 1) {
      const message = session.messages[messageIndex] || {};
      const info = message.info || {};
      const messageKey = `${sessionId}:${text(info.id) || messageIndex}`;
      if (info.role === "assistant" && info.tokens && typeof info.tokens === "object") modelMessages.add(messageKey);
      for (let partIndex = 0; partIndex < (message.parts || []).length; partIndex += 1) {
        const part = message.parts[partIndex] || {};
        if (String(part.type || "").toLowerCase() !== "tool") continue;
        const callId = text(part.callID) || text(part.callId) || text(part.id) || `${messageKey}:${partIndex}`;
        toolCalls.add(`${sessionId}:${callId}`);
      }
    }
  }
  return { modelCalls: modelMessages.size, toolCalls: toolCalls.size, available: true };
}

async function collectAgentCase(result) {
  const eventCounts = await agentEventCounts(result?.logs?.messagesPath);
  return {
    case: text(result?.case),
    status: status(result?.agentStatus || result?.status),
    elapsedSec: number(result?.agentElapsedSec ?? result?.elapsedSec),
    tokenUsage: tokenUsage(result?.tokenUsage),
    modelCalls: eventCounts.modelCalls,
    toolCalls: eventCounts.toolCalls,
    compile: compileUsage(result?.agentCompile),
    metricsSource: eventCounts.available ? "all-messages.json" : "unavailable",
    messagesPath: text(result?.logs?.messagesPath),
    transcriptPath: text(result?.logs?.transcriptPath),
  };
}

function deviceSummary(device = {}, categories = {}) {
  const suites = Array.isArray(device.suiteResults) ? device.suiteResults : [];
  return {
    id: text(device.id), profile: text(device.profile), target: text(device.target), status: status(device.status),
    testsRun: number(device.testsRun), passes: number(device.passes), failures: number(device.failures), errors: number(device.errors), ignored: number(device.ignored), durationSec: durationSeconds(device.durationMs),
    suites: suites.map((suite) => ({
      name: text(suite.suiteClass), status: status(suite.status), testsRun: number(suite.testsRun), passes: number(suite.passes), failures: number(suite.failures), errors: number(suite.errors), ignored: number(suite.ignored), durationSec: durationSeconds(suite.durationMs),
      tests: (Array.isArray(suite.testCases) ? suite.testCases : []).map((test) => ({
        name: text(test.name),
        category: categories.failToPass?.has(test.name) ? "fail_to_pass" : categories.passToPass?.has(test.name) ? "pass_to_pass" : "--",
        status: status(test.status),
        durationSec: durationSeconds(test.durationMs),
      })),
    })),
  };
}

async function collectOhosTestCase(result) {
  const ohosTest = result?.ohosTest || {};
  const runnerResult = await readJson(ohosTest.resultPath);
  const swe = runnerResult?.runs?.swe || {};
  const categories = {
    failToPass: new Set(Array.isArray(runnerResult?.metadata?.failToPass) ? runnerResult.metadata.failToPass : []),
    passToPass: new Set(Array.isArray(runnerResult?.metadata?.passToPass) ? runnerResult.metadata.passToPass : []),
  };
  const devices = (Array.isArray(swe.devices) ? swe.devices : []).map((device) => deviceSummary(device, categories));
  return {
    case: text(result?.case), status: status(ohosTest.status), runnerStatus: text(ohosTest.runnerStatus), elapsedSec: number(ohosTest.elapsedSec), error: text(ohosTest.error),
    sourceResultPath: text(ohosTest.resultPath), sourceSummaryPath: text(ohosTest.summaryPath), runnerOutputAvailable: Boolean(runnerResult),
    run: runnerResult ? {
      status: status(swe.status), durationSec: durationSeconds(swe.durationMs),
      build: { status: status(swe.build?.status), durationSec: durationSeconds(swe.build?.durationMs), appHap: text(swe.build?.appHap), testHap: text(swe.build?.testHap) },
      devices,
      diagnostics: Array.isArray(runnerResult.diagnostics) ? runnerResult.diagnostics.map(text).filter(Boolean) : [],
    } : null,
  };
}

function buildAgentSummary(cases) {
  return {
    inputTokens: addMetrics(cases.map((item) => item.tokenUsage), "input"),
    outputTokens: addMetrics(cases.map((item) => item.tokenUsage), "output"),
    totalTokens: addMetrics(cases.map((item) => item.tokenUsage), "total"),
    modelCalls: addMetrics(cases, "modelCalls"), toolCalls: addMetrics(cases, "toolCalls"), compileAttempts: addMetrics(cases.map((item) => item.compile), "attempts"),
    compile: { succeeded: addMetrics(cases.map((item) => item.compile), "succeeded"), failed: addMetrics(cases.map((item) => item.compile), "failed"), interrupted: addMetrics(cases.map((item) => item.compile), "interrupted"), running: addMetrics(cases.map((item) => item.compile), "running") },
    cases,
  };
}

function buildOhosTestSummary(cases) {
  const devices = cases.flatMap((item) => item.run?.devices || []);
  return {
    cases: cases.length, completed: cases.filter((item) => item.status === "completed").length, failed: cases.filter((item) => ["failed", "timed_out", "interrupted"].includes(item.status)).length,
    devices: devices.length, testsRun: addMetrics(devices, "testsRun"), passes: addMetrics(devices, "passes"), failures: addMetrics(devices, "failures"), errors: addMetrics(devices, "errors"), ignored: addMetrics(devices, "ignored"), caseResults: cases,
  };
}

function renderMarkdown(report) {
  const lines = [
    "# Autorun 批次执行报告", "", "## 批次概览", "",
    table(["项目", "值"], [["批次 ID", report.batchId], ["批次状态", report.status], ["生成时间", report.generatedAt], ["可执行用例", report.batch.executableCases], ["完成 / 失败 / 跳过", `${report.batch.completed} / ${report.batch.failed} / ${report.batch.skipped}`]]),
    "", "## Agent 输出汇总", "",
    table(["指标", "值"], [["输入 Token", report.agent.inputTokens], ["输出 Token", report.agent.outputTokens], ["总 Token", report.agent.totalTokens], ["模型调用次数", report.agent.modelCalls], ["工具调用次数", report.agent.toolCalls], ["编译尝试次数", report.agent.compileAttempts]]),
    "",
    table(["用例", "生成状态", "输入 Token", "输出 Token", "总 Token", "模型调用", "工具调用", "编译次数", "耗时"], report.agent.cases.map((item) => [item.case, item.status, item.tokenUsage.input, item.tokenUsage.output, item.tokenUsage.total, item.modelCalls, item.toolCalls, item.compile.attempts, durationText(item.elapsedSec)])),
    "", "## OhosTest 输出汇总", "",
    table(["指标", "值"], [["参与用例", report.ohosTest.cases], ["完成 / 失败", `${report.ohosTest.completed} / ${report.ohosTest.failed}`], ["设备执行数", report.ohosTest.devices], ["测试数 / 通过 / 失败 / 错误 / 忽略", `${report.ohosTest.testsRun} / ${report.ohosTest.passes} / ${report.ohosTest.failures} / ${report.ohosTest.errors} / ${report.ohosTest.ignored}`]]), "",
  ];
  for (const item of report.ohosTest.caseResults) {
    lines.push(`### ${item.case}`, "");
    lines.push(table(["测试状态", "Runner 状态", "耗时", "结果文件"], [[item.status, item.runnerStatus || "--", durationText(item.elapsedSec), item.sourceResultPath || "未生成"]]), "");
    if (item.error) lines.push(`- 错误：${item.error}`, "");
    if (!item.run) { lines.push("- 未读取到 OhosTest `result.json`，请结合 Runner 控制台日志排查。", ""); continue; }
    lines.push("#### 构建", "");
    lines.push(table(["状态", "耗时", "App HAP", "Test HAP"], [[item.run.build.status, durationText(item.run.build.durationSec), item.run.build.appHap || "--", item.run.build.testHap || "--"]]), "");
    lines.push("#### 设备结果", "");
    lines.push(table(["设备", "Profile", "状态", "测试数", "通过", "失败", "错误", "忽略", "耗时"], item.run.devices.map((device) => [device.id || "--", device.profile || "--", device.status, device.testsRun, device.passes, device.failures, device.errors, device.ignored, durationText(device.durationSec)])));
    const suites = item.run.devices.flatMap((device) => device.suites.map((suite) => ({ device, suite })));
    if (suites.length) {
      lines.push("", "#### 测试套结果", "");
      lines.push(table(["设备", "测试套", "状态", "测试数", "通过", "失败", "错误", "忽略", "耗时"], suites.map(({ device, suite }) => [device.profile || device.id || "--", suite.name || "--", suite.status, suite.testsRun, suite.passes, suite.failures, suite.errors, suite.ignored, durationText(suite.durationSec)])));
    }
    const tests = item.run.devices.flatMap((device) => device.suites.flatMap((suite) => suite.tests.map((test) => ({ device, suite, test }))));
    if (tests.length) {
      lines.push("", "#### 断点测试结果", "");
      lines.push(table(["设备", "测试套", "测试项", "类别", "SWE 实际", "耗时"], tests.map(({ device, suite, test }) => [device.profile || device.id || "--", suite.name || "--", test.name, test.category, test.status, durationText(test.durationSec)])));
    }
    if (item.run.diagnostics.length) { lines.push("", "#### Runner 诊断", ""); for (const diagnostic of item.run.diagnostics) lines.push(`- ${diagnostic}`); }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

export async function writeBatchReport({ batchRoot, summary }) {
  const results = Array.isArray(summary?.results) ? summary.results : [];
  const agentCases = await Promise.all(results.map(collectAgentCase));
  const ohosTestCases = await Promise.all(results.filter((item) => item?.ohosTest).map(collectOhosTestCase));
  const report = {
    schemaVersion: "autorun-batch-report-v1", batchId: text(summary?.batchId), status: status(summary?.status), generatedAt: new Date().toISOString(),
    batch: { executableCases: number(summary?.total), completed: number(summary?.completed), failed: number(summary?.failed), skipped: Array.isArray(summary?.skipped) ? summary.skipped.length : 0, skippedCases: Array.isArray(summary?.skipped) ? summary.skipped : [] },
    agent: buildAgentSummary(agentCases), ohosTest: buildOhosTestSummary(ohosTestCases),
  };
  const jsonPath = path.join(batchRoot, "report.json");
  const markdownPath = path.join(batchRoot, "report.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(markdownPath, renderMarkdown(report), "utf8");
  return { jsonPath, markdownPath };
}

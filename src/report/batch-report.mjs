import fs from "node:fs/promises";
import path from "node:path";
import { writeHtmlReport } from "./html-report.mjs";

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
    cases: cases.length, completed: cases.filter((item) => item.status === "completed").length, failed: cases.filter((item) => ["failed", "timed_out", "rate_limited", "interrupted"].includes(item.status)).length,
    devices: devices.length, testsRun: addMetrics(devices, "testsRun"), passes: addMetrics(devices, "passes"), failures: addMetrics(devices, "failures"), errors: addMetrics(devices, "errors"), ignored: addMetrics(devices, "ignored"), caseResults: cases,
  };
}

export function buildWhiteboxSummary(results, enabled) {
  const cases = results
    .filter((item) => item?.whitebox)
    .map((item) => ({ case: text(item.case), ...item.whitebox }));
  const scores = cases
    .map((item) => Number(item.totalScore))
    .filter((value) => Number.isFinite(value));
  return {
    enabled: enabled === true,
    completed: cases.filter((item) => item.status === "completed").length,
    failed: cases.filter((item) => item.status !== "completed").length,
    averageScore: scores.length
      ? Math.round((scores.reduce((sum, value) => sum + value, 0) / scores.length) * 100) / 100
      : null,
    cases,
  };
}

export async function writeBatchReport({ batchRoot, summary, uploadConfig }) {
  const results = Array.isArray(summary?.results) ? summary.results : [];
  const agentCases = await Promise.all(results.map(collectAgentCase));
  const ohosTestCases = await Promise.all(results.filter((item) => item?.ohosTest).map(collectOhosTestCase));
  const agentSummary = buildAgentSummary(agentCases);
  const representativeResult = results.find((item) => item?.agent || item?.providerId || item?.modelId) || {};
  const report = {
    schemaVersion: "autorun-batch-report-v1", batchId: text(summary?.batchId), status: status(summary?.status), generatedAt: new Date().toISOString(),
    batch: { executableCases: number(summary?.total), completed: number(summary?.completed), failed: number(summary?.failed), skipped: Array.isArray(summary?.skipped) ? summary.skipped.length : 0, skippedCases: Array.isArray(summary?.skipped) ? summary.skipped : [] },
    agent: {
      type: text(summary?.agent || representativeResult.agent),
      providerId: text(summary?.providerId || representativeResult.providerId),
      modelId: text(summary?.modelId || representativeResult.modelId),
      ...agentSummary,
    },
    ohosTest: buildOhosTestSummary(ohosTestCases),
    whitebox: buildWhiteboxSummary(results, summary?.whiteboxEvaluation?.enabled),
  };
  const jsonPath = path.join(batchRoot, "report.json");
  await fs.rm(path.join(batchRoot, "report.md"), { force: true });
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  // 打包失败用例产物，upload.enabled 时同时上传到 AGC 云存储
  try {
    const { uploadFailedCases } = await import("../artifacts/upload-orchestrator.mjs");
    await uploadFailedCases({ batchRoot, summary, report, enabled: uploadConfig?.enabled === true, onLog: (m) => console.log(`[upload] ${m}`) });
  } catch (error) {
    console.warn(`[warn] 批量打包/上传失败: ${error.message}`);
  }
  const html = { overviewPath: "", subpageDir: "" };
  try {
    const result = await writeHtmlReport({ batchRoot, summary });
    html.overviewPath = result.overviewPath;
    html.subpageDir = result.subpageDir;
  } catch (error) {
    html.error = error.message;
  }
  return { jsonPath, htmlOverviewPath: html.overviewPath, htmlError: html.error };
}

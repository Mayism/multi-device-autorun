import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { addTokenUsage, emptyTokenUsage } from "../agent/token-usage.mjs";
import { addCompileUsage, emptyCompileUsage } from "../agent/compile-usage.mjs";
import { writeBatchReport } from "../reporting/batch-report.mjs";
import { atomicWriteJson, exists, readJson } from "../shared/fs.mjs";

export function batchId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const time = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${time}_${randomUUID().slice(0, 8)}`;
}

export class BatchStateStore {
  constructor(filePath, state) {
    this.filePath = filePath;
    this.state = state;
    this.writeChain = Promise.resolve();
  }

  setBatch(values) {
    Object.assign(this.state, values, { updatedAt: new Date().toISOString() });
    return this.persist();
  }

  setCase(caseName, values) {
    Object.assign(this.state.cases[caseName], values, { updatedAt: new Date().toISOString() });
    return this.persist();
  }

  persist() {
    const snapshot = structuredClone(this.state);
    this.writeChain = this.writeChain.then(() => atomicWriteJson(this.filePath, snapshot));
    return this.writeChain;
  }
}

const FINISHED_CASE_STATUSES = new Set(["completed", "failed", "timed_out", "cancelled", "interrupted"]);

export async function loadRetryPlan(outputRoot, batchId, requestedCaseName = "") {
  const normalizedBatchId = String(batchId || "").trim();
  const resolvedOutputRoot = path.resolve(outputRoot);
  const sourceBatchRoot = path.resolve(resolvedOutputRoot, normalizedBatchId);
  const relativeBatchPath = path.relative(resolvedOutputRoot, sourceBatchRoot);
  if (
    !normalizedBatchId
    || path.basename(normalizedBatchId) !== normalizedBatchId
    || !relativeBatchPath
    || path.isAbsolute(relativeBatchPath)
    || relativeBatchPath === ".."
    || relativeBatchPath.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`无效的重试批次 ID: ${batchId || "<empty>"}`);
  }

  const batch = await readJson(path.join(sourceBatchRoot, "batch.json"));
  const summary = await readJson(path.join(sourceBatchRoot, "summary.json"));
  if (!batch?.cases || typeof batch.cases !== "object") {
    throw new Error(`重试批次不存在或 batch.json 无效: ${sourceBatchRoot}`);
  }

  const summaryResults = new Map(
    (Array.isArray(summary?.results) ? summary.results : [])
      .filter((item) => item?.case)
      .map((item) => [String(item.case), item]),
  );
  const previousResults = new Map();
  for (const [caseName, caseState] of Object.entries(batch.cases)) {
    const resultPath = caseState?.resultPath || path.join(sourceBatchRoot, caseName, "result.json");
    const result = await readJson(resultPath);
    previousResults.set(caseName, result || summaryResults.get(caseName) || {
      case: caseName,
      status: caseState?.status || "failed",
      agentStatus: caseState?.agentStatus || "",
      error: caseState?.error || "",
      projectName: caseState?.projectName || "",
      projectDir: caseState?.projectDir || "",
      patchPath: caseState?.patchPath || "",
      resultPath,
    });
  }

  const caseNames = [...previousResults.keys()];
  let selectedCaseNames;
  if (requestedCaseName) {
    const requested = String(requestedCaseName).trim();
    const exact = caseNames.find((name) => name === requested);
    const insensitive = caseNames.filter((name) => name.toLowerCase() === requested.toLowerCase());
    const matched = exact || (insensitive.length === 1 ? insensitive[0] : "");
    if (!matched) {
      throw new Error(`批次 ${normalizedBatchId} 中不存在用例 ${requested}；可选用例: ${caseNames.join(", ")}`);
    }
    selectedCaseNames = [matched];
  } else {
    selectedCaseNames = caseNames.filter((caseName) => {
      const status = previousResults.get(caseName)?.status || batch.cases[caseName]?.status || "";
      return status !== "completed" && status !== "skipped";
    });
    if (!selectedCaseNames.length) {
      throw new Error(`批次 ${normalizedBatchId} 没有可重试的失败或中断用例`);
    }
  }

  return {
    sourceBatchId: normalizedBatchId,
    sourceBatchRoot,
    requestedCaseName: requestedCaseName ? selectedCaseNames[0] : "",
    selectedCaseNames,
    previousResults,
  };
}

export function elapsedSeconds(startedAt, finishedAt) {
  const start = Date.parse(startedAt || "");
  const finish = Date.parse(finishedAt || "");
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return 0;
  return Math.max(0, Math.round((finish - start) / 1000));
}

// 判断 pid 是否仍在运行（batch.pid 存在且进程活着 → 批次仍在本机执行，不参与恢复）
function isProcessAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function recoverInterruptedRuns(outputRoot, uploadConfig = {}) {
  if (!await exists(outputRoot)) return [];
  const recovered = [];
  const entries = await fs.readdir(outputRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const batchRoot = path.join(outputRoot, entry.name);
    const batchPath = path.join(batchRoot, "batch.json");
    const batch = await readJson(batchPath);
    if (!batch || batch.status !== "running" || !batch.cases || typeof batch.cases !== "object") continue;
    // 活进程持有中的批次不是遗留状态（如长时间云测试轮询期间 batch.json 不更新），跳过
    const pidFile = path.join(batchRoot, "batch.pid");
    const pidText = (await fs.readFile(pidFile, "utf8").catch(() => "")).trim();
    if (pidText && isProcessAlive(pidText)) continue;

    const recoveredAt = new Date().toISOString();
    const results = [];
    for (const [caseName, current] of Object.entries(batch.cases)) {
      if (FINISHED_CASE_STATUSES.has(current.status)) {
        const existingResult = current.resultPath ? await readJson(current.resultPath) : null;
        results.push(existingResult || {
          case: caseName,
          status: current.status,
          error: current.error || "",
          startedAt: current.startedAt || "",
          finishedAt: current.finishedAt || recoveredAt,
          tokenUsage: current.tokenUsage || emptyTokenUsage(),
          agentCompile: current.agentCompile || emptyCompileUsage(),
        });
        continue;
      }

      const started = current.status !== "pending";
      const status = started ? "interrupted" : "cancelled";
      const error = started
        ? "上次 Autorun 进程在用例完成前退出"
        : "上次批次被中断，用例尚未开始执行";
      Object.assign(current, {
        status,
        stage: status,
        error,
        finishedAt: recoveredAt,
        updatedAt: recoveredAt,
        recoveredAt,
      });

      const existingResultPath = current.resultPath || (current.runDir ? path.join(current.runDir, "result.json") : "");
      const existingResult = existingResultPath ? await readJson(existingResultPath) : null;
      const result = {
        ...(existingResult || {}),
        case: caseName,
        status,
        sessionId: current.sessionId || "",
        childSessionIds: current.childSessionIds || [],
        error,
        startedAt: current.startedAt || "",
        finishedAt: recoveredAt,
        elapsedSec: elapsedSeconds(current.startedAt, recoveredAt),
        projectDir: current.projectDir || "",
        recoveredAt,
        tokenUsage: current.tokenUsage || emptyTokenUsage(),
        agentCompile: existingResult?.agentCompile || current.agentCompile || emptyCompileUsage(),
      };
      if (started && current.runDir) {
        const generateDir = path.join(current.runDir, "generate");
        const patchPath = path.join(current.runDir, "diff", "changes.patch");
        const resultPath = current.resultPath || path.join(current.runDir, "result.json");
        result.resultPath = resultPath;
        result.patchPath = await exists(patchPath) ? patchPath : "";
        result.logs = {
          ...(existingResult?.logs || {}),
          transcriptPath: await exists(path.join(generateDir, "agent-output.log")) ? path.join(generateDir, "agent-output.log") : "",
          messagesPath: await exists(path.join(generateDir, "all-messages.json")) ? path.join(generateDir, "all-messages.json") : "",
          ssePath: path.join(generateDir, "opencode-sse.jsonl"),
          pollingPath: path.join(generateDir, "opencode-polling.jsonl"),
          consolePath: path.join(generateDir, "agent-console.log"),
        };
        current.resultPath = resultPath;
        await atomicWriteJson(resultPath, result);
        const statePath = path.join(current.runDir, "state.json");
        const caseState = await readJson(statePath) || { case: caseName };
        await atomicWriteJson(statePath, { ...caseState, ...current });
      }
      results.push(result);
    }

    const failed = results.filter((item) => item.status !== "completed").length;
    const tokenUsage = addTokenUsage(...results.map((item) => item.tokenUsage));
    const agentCompile = addCompileUsage(...results.map((item) => item.agentCompile));
    const representativeResult = results.find((item) => item?.agent || item?.modelId || item?.providerId);
    const summary = {
      batchId: batch.batchId || entry.name,
      status: "interrupted",
      finishedAt: recoveredAt,
      recoveredAt,
      agent: batch.agent || representativeResult?.agent || "",
      providerId: batch.providerId || representativeResult?.providerId || "",
      modelId: batch.modelId || representativeResult?.modelId || "",
      total: results.length,
      completed: results.filter((item) => item.status === "completed").length,
      failed,
      tokenUsage,
      agentCompile,
      results,
    };
    Object.assign(batch, {
      status: "interrupted",
      finishedAt: recoveredAt,
      updatedAt: recoveredAt,
      recoveredAt,
      error: "检测到上次 Autorun 未正常完成，已收尾遗留用例状态",
    });
    try {
      summary.reports = await writeBatchReport({ batchRoot, summary, uploadConfig });
    } catch (error) {
      summary.reportError = error.message;
      console.warn(`[warn] 批次报告生成失败: ${error.message}`);
    }
    await atomicWriteJson(path.join(batchRoot, "summary.json"), summary);
    await atomicWriteJson(batchPath, batch);
    recovered.push({ batchId: batch.batchId || entry.name, batchRoot });
  }
  return recovered;
}



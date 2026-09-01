import fs from "node:fs/promises";
import path from "node:path";
import type { RemoteTaskRecord, RemoteTaskRegistry } from "../../api/remoteTaskRegistry.js";
import type {
  DashboardStatusCategory,
  DashboardTaskRecordWithResult,
  DashboardTaskSummary,
  HumanRatingGapDashboardItem,
  HumanRatingGapReadResult,
  ManualAnalysisStatus,
  RiskReviewCalibrationDashboardItem,
  RiskReviewCalibrationReadResult,
} from "./dashboardTypes.js";

const HUMAN_RATING_GAP_DATASET = "human_rating_gap_analyses.jsonl";
const RISK_REVIEW_CALIBRATION_DATASET = "risk_review_calibrations.jsonl";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readTokenUsage(value: unknown): Record<string, number | undefined> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const cache = asRecord(record.cache);
  const tokenUsage = {
    total: readFiniteNumber(record.total),
    input: readFiniteNumber(record.input),
    output: readFiniteNumber(record.output),
    reasoning: readFiniteNumber(record.reasoning),
    cacheRead: readFiniteNumber(cache?.read),
    cacheWrite: readFiniteNumber(cache?.write),
  };
  return Object.values(tokenUsage).some((item) => item !== undefined) ? tokenUsage : undefined;
}

function readRawTokenUsage(
  rawPayload: Record<string, unknown> | undefined,
): Record<string, number | undefined> | undefined {
  const part = asRecord(rawPayload?.part);
  const properties = asRecord(rawPayload?.properties);
  const info = asRecord(rawPayload?.info) ?? asRecord(properties?.info);
  return (
    readTokenUsage(rawPayload?.tokens) ??
    readTokenUsage(part?.tokens) ??
    readTokenUsage(info?.tokens)
  );
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}

function normalizeManualAnalysisStatus(value: unknown): ManualAnalysisStatus {
  return value === "analyzed" ? "analyzed" : "pending";
}

function normalizeManualAnalyzedAt(
  status: ManualAnalysisStatus,
  value: unknown,
): string | undefined {
  return status === "analyzed" && typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function applyManualAnalysisStatusFields<T extends Record<string, unknown>>(
  item: T,
  status: ManualAnalysisStatus,
  nowIso: string,
): T & { manualAnalysisStatus: ManualAnalysisStatus; manualAnalyzedAt?: string } {
  const next: T & { manualAnalysisStatus: ManualAnalysisStatus; manualAnalyzedAt?: string } = {
    ...item,
    manualAnalysisStatus: status,
  };
  if (status === "analyzed") {
    next.manualAnalyzedAt = nowIso;
  } else {
    delete next.manualAnalyzedAt;
  }
  return next;
}

function isDisagreedRiskReview(record: Record<string, unknown>): boolean {
  const humanReview = asRecord(record.humanReview);
  const agreed = humanReview?.agreeWithResultLevel ?? humanReview?.agree;
  return agreed === false;
}

async function readDatasetLines(filePath: string): Promise<string[] | undefined> {
  try {
    return (await fs.readFile(filePath, "utf-8")).split("\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function rewriteDatasetLines(filePath: string, lines: string[]): Promise<void> {
  const content = lines.join("\n");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${String(process.pid)}.${String(Date.now())}.tmp`;
  await fs.writeFile(tempPath, content.endsWith("\n") ? content : `${content}\n`, "utf-8");
  await fs.rename(tempPath, filePath);
}

export function statusCategory(status: RemoteTaskRecord["status"]): DashboardStatusCategory {
  switch (status) {
    case "preparing":
      return "received";
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
    case "timed_out":
      return "failed";
  }
}

function readScore(resultJson: Record<string, unknown>): number | null {
  const overall = asRecord(resultJson.overall_conclusion);
  const score = overall?.total_score;
  return typeof score === "number" && Number.isFinite(score) ? score : null;
}

function readHardGate(resultJson: Record<string, unknown>): boolean | null {
  const overall = asRecord(resultJson.overall_conclusion);
  const hardGate = overall?.hard_gate_triggered;
  return typeof hardGate === "boolean" ? hardGate : null;
}

function readCaseName(resultJson: Record<string, unknown>): string | undefined {
  const basicInfo = asRecord(resultJson.basic_info);
  const caseName = basicInfo?.case_name ?? basicInfo?.name;
  return typeof caseName === "string" && caseName.trim().length > 0 ? caseName : undefined;
}

function readTaskType(resultJson: Record<string, unknown>): string | undefined {
  const basicInfo = asRecord(resultJson.basic_info);
  const taskType = basicInfo?.task_type;
  return typeof taskType === "string" && taskType.trim().length > 0 ? taskType : undefined;
}

function readRemoteCaseName(caseInfo: Record<string, unknown> | undefined): string | undefined {
  const caseName =
    caseInfo?.remote_test_case_name ?? caseInfo?.test_case_name ?? caseInfo?.case_name;
  return typeof caseName === "string" && caseName.trim().length > 0 ? caseName : undefined;
}

function readRemoteTaskType(caseInfo: Record<string, unknown> | undefined): string | undefined {
  const taskType = caseInfo?.remote_test_case_type ?? caseInfo?.task_type;
  return typeof taskType === "string" && taskType.trim().length > 0 ? taskType : undefined;
}

function readRisks(resultJson: Record<string, unknown>): Array<{ level?: string; title?: string }> {
  const risks = resultJson.risks;
  if (!Array.isArray(risks)) {
    return [];
  }
  return risks
    .map((risk): { level?: string; title?: string } | undefined => {
      const record = asRecord(risk);
      if (!record) {
        return undefined;
      }
      return {
        level: typeof record.level === "string" ? record.level : undefined,
        title: typeof record.title === "string" ? record.title : undefined,
      };
    })
    .filter((risk): risk is { level?: string; title?: string } => Boolean(risk));
}

async function readResultJson(
  record: RemoteTaskRecord,
): Promise<Record<string, unknown> | undefined> {
  if (!record.caseDir) {
    return undefined;
  }
  const text = await fs.readFile(path.join(record.caseDir, "outputs", "result.json"), "utf-8");
  return JSON.parse(text) as Record<string, unknown>;
}

async function readCaseInfo(
  record: RemoteTaskRecord,
): Promise<Record<string, unknown> | undefined> {
  if (!record.caseDir) {
    return undefined;
  }
  const text = await fs.readFile(path.join(record.caseDir, "inputs", "case-info.json"), "utf-8");
  return JSON.parse(text) as Record<string, unknown>;
}

export async function listDashboardTasks(
  registry: RemoteTaskRegistry,
): Promise<DashboardTaskRecordWithResult[]> {
  const records = await registry.list();
  return await Promise.all(
    records.map(async (record) => {
      let resultJson: Record<string, unknown> | undefined;
      let resultError: string | undefined;
      let caseInfo: Record<string, unknown> | undefined;
      try {
        resultJson = await readResultJson(record);
      } catch (error) {
        resultError = error instanceof Error ? error.message : String(error);
      }
      try {
        caseInfo = await readCaseInfo(record);
      } catch {
        caseInfo = undefined;
      }

      const name =
        (resultJson ? readCaseName(resultJson) : undefined) ??
        readRemoteCaseName(caseInfo) ??
        record.testCaseName ??
        `Task ${String(record.taskId)}`;
      const taskType =
        (resultJson ? readTaskType(resultJson) : undefined) ??
        readRemoteTaskType(caseInfo) ??
        record.testCaseType ??
        "unknown";
      const summary: DashboardTaskSummary = {
        taskId: record.taskId,
        testCaseId: record.testCaseId,
        name,
        status: record.status,
        statusCategory: statusCategory(record.status),
        taskType,
        score: resultJson ? readScore(resultJson) : null,
        hardGateTriggered: resultJson ? readHardGate(resultJson) : null,
        createdAt: toIso(record.createdAt),
        updatedAt: toIso(record.updatedAt),
        resultAvailable: Boolean(resultJson),
        resultError,
        error: record.error,
        risks: resultJson ? readRisks(resultJson) : [],
      };
      return { record, summary };
    }),
  );
}

export async function readTaskLog(input: {
  registry: RemoteTaskRegistry;
  taskId: number;
  tailBytes: number;
}): Promise<
  | { found: false }
  | {
      found: true;
      status: RemoteTaskRecord["status"];
      available: boolean;
      truncated: boolean;
      content: string;
      tailBytes: number;
    }
> {
  const record = await input.registry.get(input.taskId);
  if (!record) {
    return { found: false };
  }
  if (!record.caseDir) {
    return {
      found: true,
      status: record.status,
      available: false,
      truncated: false,
      content: "",
      tailBytes: input.tailBytes,
    };
  }
  try {
    const logPath = path.join(record.caseDir, "logs", "run.log");
    const stat = await fs.stat(logPath);
    const start = Math.max(0, stat.size - input.tailBytes);
    const file = await fs.open(logPath, "r");
    try {
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, start);
      return {
        found: true,
        status: record.status,
        available: true,
        truncated: start > 0,
        content: buffer.toString("utf-8"),
        tailBytes: input.tailBytes,
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        found: true,
        status: record.status,
        available: false,
        truncated: false,
        content: "",
        tailBytes: input.tailBytes,
      };
    }
    throw error;
  }
}

async function readAgentTraceArtifact(
  caseDir: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await fs.readFile(path.join(caseDir, "outputs", "agent-trace.json"), "utf-8");
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function asMutableRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : undefined;
}

function summarizeAgentTraceReport(report: Record<string, unknown>): Record<string, unknown> {
  const runs = Array.isArray(report.runs) ? report.runs : [];
  return {
    ...report,
    runs: runs
      .map((run) => {
        const runRecord = asMutableRecord(run);
        if (!runRecord) {
          return undefined;
        }
        delete runRecord.prompt;
        delete runRecord.assistantText;
        delete runRecord.outputFileText;
        delete runRecord.opencodeMessages;
        runRecord.rawAvailable = true;
        const attempts = Array.isArray(runRecord.attempts) ? runRecord.attempts : [];
        runRecord.attempts = attempts
          .map((attempt) => {
            const attemptRecord = asMutableRecord(attempt);
            if (!attemptRecord) {
              return undefined;
            }
            delete attemptRecord.prompt;
            delete attemptRecord.assistantText;
            delete attemptRecord.outputFileText;
            return attemptRecord;
          })
          .filter(Boolean);
        const events = Array.isArray(runRecord.events) ? runRecord.events : [];
        runRecord.events = events
          .map((event) => {
            const eventRecord = asMutableRecord(event);
            if (!eventRecord) {
              return undefined;
            }
            const hasRawPayload =
              eventRecord.hasRawPayload === true || eventRecord.rawPayload !== undefined;
            if (eventRecord.timestampMs === undefined) {
              const rawPayload = asMutableRecord(eventRecord.rawPayload);
              const rawTimestampMs = readFiniteNumber(rawPayload?.timestamp);
              if (rawTimestampMs !== undefined) {
                eventRecord.timestampMs = rawTimestampMs;
              }
            }
            if (eventRecord.tokenUsage === undefined) {
              const rawPayload = asMutableRecord(eventRecord.rawPayload);
              const rawTokenUsage = readRawTokenUsage(rawPayload);
              if (rawTokenUsage) {
                eventRecord.tokenUsage = rawTokenUsage;
              }
            }
            delete eventRecord.rawPayload;
            eventRecord.hasRawPayload = hasRawPayload;
            return eventRecord;
          })
          .filter(Boolean);
        return runRecord;
      })
      .filter(Boolean),
  };
}

export async function readTaskAgentTrace(input: {
  registry: RemoteTaskRegistry;
  taskId: number;
}): Promise<
  | { found: false }
  | {
      found: true;
      traceAvailable: boolean;
      source: "artifact";
      report?: Record<string, unknown>;
      rawAvailable: boolean;
      message?: string;
    }
> {
  const record = await input.registry.get(input.taskId);
  if (!record) {
    return { found: false };
  }
  if (!record.caseDir) {
    return { found: true, traceAvailable: false, source: "artifact", rawAvailable: false };
  }
  const report = await readAgentTraceArtifact(record.caseDir);
  if (!report) {
    return { found: true, traceAvailable: false, source: "artifact", rawAvailable: false };
  }
  return {
    found: true,
    traceAvailable: true,
    source: "artifact",
    report: summarizeAgentTraceReport(report),
    rawAvailable: true,
  };
}

export async function readTaskAgentTraceRunRaw(input: {
  registry: RemoteTaskRegistry;
  taskId: number;
  traceRunId: string;
}): Promise<{ found: false } | { found: true; raw?: Record<string, unknown> }> {
  const record = await input.registry.get(input.taskId);
  if (!record?.caseDir) {
    return { found: false };
  }
  const report = await readAgentTraceArtifact(record.caseDir);
  const runs = Array.isArray(report?.runs) ? report.runs : [];
  const run = runs
    .map((item) => asMutableRecord(item))
    .find((item) => item?.id === input.traceRunId);
  if (!run) {
    return { found: false };
  }
  return {
    found: true,
    raw: {
      prompt: run.prompt,
      assistantText: run.assistantText,
      outputFileText: run.outputFileText,
      opencodeMessages: run.opencodeMessages,
    },
  };
}

export async function readTaskAgentTraceEventRaw(input: {
  registry: RemoteTaskRegistry;
  taskId: number;
  traceEventId: string;
}): Promise<{ found: false } | { found: true; rawPayload?: unknown }> {
  const record = await input.registry.get(input.taskId);
  if (!record?.caseDir) {
    return { found: false };
  }
  const report = await readAgentTraceArtifact(record.caseDir);
  const runs = Array.isArray(report?.runs) ? report.runs : [];
  for (const run of runs) {
    const runRecord = asMutableRecord(run);
    const events = Array.isArray(runRecord?.events) ? runRecord.events : [];
    for (const event of events) {
      const eventRecord = asMutableRecord(event);
      if (eventRecord?.id === input.traceEventId) {
        return { found: true, rawPayload: eventRecord.rawPayload };
      }
    }
  }
  return { found: false };
}

export async function readHumanRatingGapDataset(
  root: string,
  taskNames: Map<number, string> = new Map(),
): Promise<HumanRatingGapReadResult> {
  const filePath = path.join(root, "datasets", HUMAN_RATING_GAP_DATASET);
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { items: [], skippedRows: 0 };
    }
    throw error;
  }

  const items: HumanRatingGapDashboardItem[] = [];
  let skippedRows = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      const record = asRecord(parsed);
      if (!record || record.type !== "human_rating_gap_analysis") {
        skippedRows += 1;
        continue;
      }
      const item = record as HumanRatingGapDashboardItem;
      const hasCaseName = typeof item.caseName === "string" && item.caseName.trim().length > 0;
      const manualAnalysisStatus = normalizeManualAnalysisStatus(item.manualAnalysisStatus);
      const manualAnalyzedAt = normalizeManualAnalyzedAt(
        manualAnalysisStatus,
        item.manualAnalyzedAt,
      );
      items.push({
        ...item,
        caseName: hasCaseName
          ? item.caseName
          : (taskNames.get(item.taskId) ?? `Task ${String(item.taskId)}`),
        manualAnalysisStatus,
        ...(manualAnalyzedAt ? { manualAnalyzedAt } : {}),
      });
    } catch {
      skippedRows += 1;
    }
  }
  return { items, skippedRows };
}

export async function readRiskReviewCalibrationDataset(
  root: string,
  taskNames: Map<number, string>,
): Promise<RiskReviewCalibrationReadResult> {
  const filePath = path.join(root, "datasets", RISK_REVIEW_CALIBRATION_DATASET);
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { items: [], skippedRows: 0 };
    }
    throw error;
  }

  const items: RiskReviewCalibrationDashboardItem[] = [];
  let skippedRows = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      const record = asRecord(parsed);
      if (!record || record.type !== "risk_review_calibration") {
        skippedRows += 1;
        continue;
      }
      const taskId = record.taskId;
      if (typeof taskId !== "number") {
        skippedRows += 1;
        continue;
      }
      const hasCaseName = typeof record.caseName === "string" && record.caseName.trim().length > 0;
      const item = record as RiskReviewCalibrationDashboardItem;
      const manualAnalysisStatus = normalizeManualAnalysisStatus(item.manualAnalysisStatus);
      const manualAnalyzedAt = normalizeManualAnalyzedAt(
        manualAnalysisStatus,
        item.manualAnalyzedAt,
      );
      items.push({
        ...item,
        caseName: hasCaseName
          ? (record.caseName as string)
          : (taskNames.get(taskId) ?? `Task ${String(taskId)}`),
        manualAnalysisStatus,
        ...(manualAnalyzedAt ? { manualAnalyzedAt } : {}),
      });
    } catch {
      skippedRows += 1;
    }
  }
  return { items, skippedRows };
}

export async function updateHumanRatingGapManualAnalysisStatus(
  root: string,
  taskIds: number[],
  status: ManualAnalysisStatus,
  nowIso = new Date().toISOString(),
): Promise<{ updated: number; missing: Array<{ taskId: number }> }> {
  const filePath = path.join(root, "datasets", HUMAN_RATING_GAP_DATASET);
  const lines = await readDatasetLines(filePath);
  const requested = new Set(taskIds);
  const found = new Set<number>();
  let updated = 0;
  if (!lines) {
    return { updated, missing: taskIds.map((taskId) => ({ taskId })) };
  }

  const rewritten = lines.map((line) => {
    if (line.trim().length === 0) {
      return line;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      const record = asRecord(parsed);
      if (
        !record ||
        record.type !== "human_rating_gap_analysis" ||
        typeof record.taskId !== "number" ||
        !requested.has(record.taskId)
      ) {
        return line;
      }
      found.add(record.taskId);
      updated += 1;
      return JSON.stringify(applyManualAnalysisStatusFields(record, status, nowIso));
    } catch {
      return line;
    }
  });

  await rewriteDatasetLines(filePath, rewritten);
  return {
    updated,
    missing: taskIds.filter((taskId) => !found.has(taskId)).map((taskId) => ({ taskId })),
  };
}

export async function updateRiskReviewManualAnalysisStatus(
  root: string,
  items: Array<{ taskId: number; riskId: number }>,
  status: ManualAnalysisStatus,
  nowIso = new Date().toISOString(),
): Promise<{
  updated: number;
  missing: Array<{ taskId: number; riskId: number }>;
  skipped: Array<{ taskId: number; riskId: number; reason: "not_disagreed" }>;
}> {
  const filePath = path.join(root, "datasets", RISK_REVIEW_CALIBRATION_DATASET);
  const lines = await readDatasetLines(filePath);
  const requested = new Map(
    items.map((item) => [`${String(item.taskId)}:${String(item.riskId)}`, item]),
  );
  const found = new Set<string>();
  const skipped: Array<{ taskId: number; riskId: number; reason: "not_disagreed" }> = [];
  let updated = 0;
  if (!lines) {
    return { updated, missing: items, skipped };
  }

  const rewritten = lines.map((line) => {
    if (line.trim().length === 0) {
      return line;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      const record = asRecord(parsed);
      if (
        !record ||
        record.type !== "risk_review_calibration" ||
        typeof record.taskId !== "number" ||
        typeof record.riskId !== "number"
      ) {
        return line;
      }
      const key = `${String(record.taskId)}:${String(record.riskId)}`;
      const requestedItem = requested.get(key);
      if (!requestedItem) {
        return line;
      }
      found.add(key);
      if (!isDisagreedRiskReview(record)) {
        skipped.push({ ...requestedItem, reason: "not_disagreed" });
        return line;
      }
      updated += 1;
      return JSON.stringify(applyManualAnalysisStatusFields(record, status, nowIso));
    } catch {
      return line;
    }
  });

  await rewriteDatasetLines(filePath, rewritten);
  return {
    updated,
    missing: items.filter((item) => !found.has(`${String(item.taskId)}:${String(item.riskId)}`)),
    skipped,
  };
}

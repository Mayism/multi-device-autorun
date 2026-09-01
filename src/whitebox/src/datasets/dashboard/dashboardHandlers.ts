import express, { Request, Response } from "express";
import type { AgentTraceSqliteStore } from "../../agents/trace/sqliteStore.js";
import type { RemoteTaskRegistry } from "../../api/remoteTaskRegistry.js";
import type { RuleViolationStatsStore } from "../../api/ruleViolationStatsStore.js";
import {
  buildNegativeResults,
  buildScoreSummary,
  buildStatusCounts,
  buildTaskTypeCounts,
  filterHumanRatingGaps,
  filterRiskReviewCalibrations,
  filterTasks,
  paginate,
  sortHumanRatingGapsByReviewedAtDesc,
  sortRiskReviewCalibrationsByTaskTimeDesc,
} from "./dashboardAggregates.js";
import {
  buildCrossDeviceRuleViolationStats,
  filterCrossDeviceCases,
  filterCrossDeviceRiskReviews,
  sortCrossDeviceCases,
} from "./crossDeviceAggregates.js";
import {
  listCrossDeviceRelatedTasks,
  readCrossDeviceRiskReviewDataset,
} from "./crossDeviceDataStore.js";
import {
  listDashboardTasks,
  readHumanRatingGapDataset,
  readRiskReviewCalibrationDataset,
  readTaskAgentTrace,
  readTaskAgentTraceEventRaw,
  readTaskAgentTraceRunRaw,
  readTaskLog,
  updateHumanRatingGapManualAnalysisStatus,
  updateRiskReviewManualAnalysisStatus,
} from "./dashboardDataStore.js";
import type {
  DashboardStatusCategory,
  DashboardTaskSummary,
  ManualAnalysisStatus,
} from "./dashboardTypes.js";

type DashboardScoreSummary = {
  completedWithScore: number;
  averageScore: number | null;
  minScore: number | null;
  maxScore: number | null;
};

export type DashboardRouterDeps = {
  registry: RemoteTaskRegistry;
  ruleViolationStatsStore: RuleViolationStatsStore;
  agentTraceStore?: AgentTraceSqliteStore;
  humanReviewEvidenceRoot: string;
  taskSummaryProvider?: (query?: {
    taskType?: string;
    from?: string;
    to?: string;
  }) => Promise<DashboardTaskSummary[]>;
  taskPageProvider?: (query: ReturnType<typeof parseTaskQuery> & object) => Promise<{
    items: DashboardTaskSummary[];
    total: number;
  }>;
  dashboardSummaryProvider?: (query: { from?: string; to?: string }) => Promise<{
    statusCounts: ReturnType<typeof buildStatusCounts>;
    taskTypeCounts: ReturnType<typeof buildTaskTypeCounts>;
    scoreSummary: DashboardScoreSummary;
  }>;
  statusCountsProvider?: () => Promise<ReturnType<typeof buildStatusCounts>>;
};

async function buildSqliteAgentTraceResponse(input: {
  taskId: number;
  store: AgentTraceSqliteStore;
}) {
  const runs = await input.store.listRunsByTaskId(input.taskId);
  if (runs.length === 0) {
    return undefined;
  }
  const reportRuns = await Promise.all(
    runs.map(async (run) => ({
      id: run.id,
      taskId: run.taskId,
      caseId: run.caseId,
      baseRequestTag: run.baseRequestTag,
      agentName: run.agentName,
      nodeId: run.nodeId,
      status: run.status,
      startedAtMs: run.startedAtMs,
      endedAtMs: run.endedAtMs,
      elapsedMs: run.elapsedMs,
      tokenUsage:
        run.totalTokens === undefined
          ? undefined
          : {
              total: run.totalTokens,
              input: run.inputTokens,
              output: run.outputTokens,
              reasoning: run.reasoningTokens,
              cacheRead: run.cacheReadTokens,
              cacheWrite: run.cacheWriteTokens,
            },
      attempts: await input.store.listAttemptsByRunId(run.id),
      events: await input.store.listEventsByRunId(run.id),
      opencodeSession: run.opencodeSessionId ? { id: run.opencodeSessionId } : undefined,
      rawAvailable: false,
      warnings: [],
    })),
  );
  return {
    summary: {
      runCount: runs.length,
      attemptCount: runs.reduce((sum, run) => sum + run.attemptCount, 0),
      eventCount: runs.reduce((sum, run) => sum + run.eventCount, 0),
      toolEventCount: runs.reduce((sum, run) => sum + run.toolEventCount, 0),
      errorCount: runs.reduce((sum, run) => sum + run.errorCount, 0),
      totalElapsedMs: runs.reduce((sum, run) => sum + run.elapsedMs, 0),
      totalTokens: runs.reduce((sum, run) => sum + (run.totalTokens ?? 0), 0) || undefined,
    },
    runs: reportRuns,
    warnings: ["完整 trace artifact 不存在，仅展示 SQLite 摘要"],
  };
}

const STATUS_CATEGORIES = new Set(["received", "queued", "running", "completed", "failed"]);
const SORT_FIELDS = new Set(["createdAt", "updatedAt", "score", "taskId"]);
const CROSS_DEVICE_SORT_FIELDS = new Set(["updatedAt", "score", "taskId"]);
const RISK_REVIEW_AGREEMENTS = new Set(["agreed", "disagreed"]);
const RISK_LEVELS = new Set(["high", "medium", "low"]);
const MANUAL_ANALYSIS_STATUSES = new Set(["pending", "analyzed"]);

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function readPositiveInteger(value: unknown, fallback: number, max: number): number | string {
  if (value === undefined) {
    return fallback;
  }
  const number = readNumber(value);
  if (number === undefined || number < 1 || !Number.isInteger(number)) {
    return "must be a positive integer";
  }
  return Math.min(number, max);
}

function readBooleanFlag(value: unknown): boolean {
  return value === "true" || value === true;
}

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ success: false, message });
}

function readManualAnalysisStatus(value: unknown): {
  status?: ManualAnalysisStatus;
  error?: string;
} {
  const status = readString(value);
  if (status === undefined) {
    return {};
  }
  if (!MANUAL_ANALYSIS_STATUSES.has(status)) {
    return { error: "manualAnalysisStatus must be one of pending, analyzed" };
  }
  return { status: status as ManualAnalysisStatus };
}

function readBodyRecord(req: Request): Record<string, unknown> {
  return typeof req.body === "object" && req.body !== null && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

function parseManualStatus(value: unknown): ManualAnalysisStatus | undefined {
  return value === "pending" || value === "analyzed" ? value : undefined;
}

function parseTaskIds(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const taskIds = value.filter(
    (item): item is number => Number.isInteger(item) && Number(item) > 0,
  );
  return taskIds.length === value.length ? taskIds : undefined;
}

function parseRiskStatusItems(
  value: unknown,
): Array<{ taskId: number; riskId: number }> | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const items: Array<{ taskId: number; riskId: number }> = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return undefined;
    }
    const record = item as Record<string, unknown>;
    if (
      !Number.isInteger(record.taskId) ||
      Number(record.taskId) <= 0 ||
      !Number.isInteger(record.riskId) ||
      Number(record.riskId) <= 0
    ) {
      return undefined;
    }
    items.push({ taskId: Number(record.taskId), riskId: Number(record.riskId) });
  }
  return items;
}

async function getTaskSummaries(
  deps: DashboardRouterDeps,
  query?: { taskType?: string; from?: string; to?: string },
) {
  if (deps.taskSummaryProvider) {
    return await deps.taskSummaryProvider(query);
  }
  return (await listDashboardTasks(deps.registry))
    .map((item) => item.summary)
    .filter(
      (task) =>
        (query?.taskType ? task.taskType === query.taskType : true) &&
        matchesCreatedRange(task, query?.from, query?.to),
    );
}

function matchesCreatedRange(task: { createdAt: string }, from?: string, to?: string): boolean {
  const createdAt = Date.parse(task.createdAt);
  if (from && createdAt < Date.parse(from)) {
    return false;
  }
  if (to && createdAt > Date.parse(to)) {
    return false;
  }
  return true;
}

function parseTaskQuery(req: Request) {
  const page = readPositiveInteger(req.query.page, 1, Number.MAX_SAFE_INTEGER);
  if (typeof page === "string") {
    return "page must be a positive integer";
  }
  const pageSize = readPositiveInteger(req.query.pageSize, 20, 100);
  if (typeof pageSize === "string") {
    return "pageSize must be a positive integer";
  }
  const status = readString(req.query.status);
  if (status !== undefined && !STATUS_CATEGORIES.has(status)) {
    return "status must be one of received, queued, running, completed, failed";
  }
  const sortBy = readString(req.query.sortBy) ?? "updatedAt";
  if (!SORT_FIELDS.has(sortBy)) {
    return "sortBy must be one of createdAt, updatedAt, score, taskId";
  }
  const sortOrder = readString(req.query.sortOrder) ?? "desc";
  if (sortOrder !== "asc" && sortOrder !== "desc") {
    return "sortOrder must be asc or desc";
  }

  return {
    status: status as DashboardStatusCategory | undefined,
    taskType: readString(req.query.taskType),
    keyword: readString(req.query.keyword),
    scoreMin: readNumber(req.query.scoreMin),
    scoreMax: readNumber(req.query.scoreMax),
    from: readString(req.query.from),
    to: readString(req.query.to),
    page,
    pageSize,
    sortBy: sortBy as "createdAt" | "updatedAt" | "score" | "taskId",
    sortOrder: sortOrder as "asc" | "desc",
  };
}

function parseCrossDeviceCaseQuery(req: Request) {
  const page = readPositiveInteger(req.query.page, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = readPositiveInteger(req.query.pageSize, 20, 100);
  if (typeof page === "string" || typeof pageSize === "string") {
    return "page and pageSize must be positive integers";
  }
  const sortBy = readString(req.query.sortBy) ?? "updatedAt";
  if (!CROSS_DEVICE_SORT_FIELDS.has(sortBy)) {
    return "sortBy must be one of updatedAt, score, taskId";
  }
  const sortOrder = readString(req.query.sortOrder) ?? "desc";
  if (sortOrder !== "asc" && sortOrder !== "desc") {
    return "sortOrder must be asc or desc";
  }
  return {
    page,
    pageSize,
    keyword: readString(req.query.keyword),
    from: readString(req.query.from),
    to: readString(req.query.to),
    taskType: readString(req.query.taskType),
    scoreMin: readNumber(req.query.scoreMin),
    scoreMax: readNumber(req.query.scoreMax),
    sortBy: sortBy as "updatedAt" | "score" | "taskId",
    sortOrder: sortOrder as "asc" | "desc",
  };
}

function parseCrossDeviceRuleQuery(req: Request) {
  const page = readPositiveInteger(req.query.page, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = readPositiveInteger(req.query.pageSize, 50, 200);
  if (typeof page === "string" || typeof pageSize === "string") {
    return "page and pageSize must be positive integers";
  }
  return {
    page,
    pageSize,
    keyword: readString(req.query.keyword),
    from: readString(req.query.from),
    to: readString(req.query.to),
    includeOtherRules: readBooleanFlag(req.query.includeOtherRules),
  };
}

function parseCrossDeviceRiskQuery(req: Request) {
  const page = readPositiveInteger(req.query.page, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = readPositiveInteger(req.query.pageSize, 20, 100);
  if (typeof page === "string" || typeof pageSize === "string") {
    return "page and pageSize must be positive integers";
  }
  const agreement = readString(req.query.agreement);
  if (agreement !== undefined && !RISK_REVIEW_AGREEMENTS.has(agreement)) {
    return "agreement must be one of agreed, disagreed";
  }
  const riskLevel = readString(req.query.riskLevel);
  if (riskLevel !== undefined && !RISK_LEVELS.has(riskLevel)) {
    return "riskLevel must be one of high, medium, low";
  }
  return {
    page,
    pageSize,
    keyword: readString(req.query.keyword),
    from: readString(req.query.from),
    to: readString(req.query.to),
    agreement: agreement as "agreed" | "disagreed" | undefined,
    riskLevel: riskLevel as "high" | "medium" | "low" | undefined,
  };
}

export function createDashboardRouter(deps: DashboardRouterDeps) {
  const router = express.Router();

  router.get("/dashboard/summary", async (req, res) => {
    try {
      const from = readString(req.query.from);
      const to = readString(req.query.to);
      if (deps.dashboardSummaryProvider) {
        res.json({
          success: true,
          generatedAt: new Date().toISOString(),
          ...(await deps.dashboardSummaryProvider({ from, to })),
        });
        return;
      }
      const tasks = (await getTaskSummaries(deps)).filter((task) =>
        matchesCreatedRange(task, from, to),
      );
      res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        statusCounts: buildStatusCounts(tasks),
        taskTypeCounts: buildTaskTypeCounts(tasks),
        scoreSummary: buildScoreSummary(tasks),
      });
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : "Dashboard summary unavailable");
    }
  });

  router.get("/dashboard/tasks", async (req, res) => {
    const query = parseTaskQuery(req);
    if (typeof query === "string") {
      sendError(res, 400, query);
      return;
    }
    try {
      if (deps.taskPageProvider) {
        const page = await deps.taskPageProvider(query);
        res.json({
          success: true,
          page: query.page,
          pageSize: query.pageSize,
          total: page.total,
          items: page.items,
        });
        return;
      }
      const filtered = filterTasks(await getTaskSummaries(deps), query);
      const page = paginate(filtered, query.page, query.pageSize);
      res.json({
        success: true,
        page: query.page,
        pageSize: query.pageSize,
        total: page.total,
        items: page.items,
      });
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : "Dashboard tasks unavailable");
    }
  });

  router.get("/dashboard/tasks/status-counts", async (_req, res) => {
    try {
      if (deps.statusCountsProvider) {
        res.json({ success: true, statusCounts: await deps.statusCountsProvider() });
        return;
      }
      res.json({ success: true, statusCounts: buildStatusCounts(await getTaskSummaries(deps)) });
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : "Dashboard status unavailable");
    }
  });

  router.get("/dashboard/tasks/:taskId/logs", async (req, res) => {
    const taskId = Number(req.params.taskId);
    if (!Number.isFinite(taskId)) {
      sendError(res, 404, "Task not found");
      return;
    }
    const tailBytes = readPositiveInteger(req.query.tailBytes, 65536, 1048576);
    if (typeof tailBytes === "string") {
      sendError(res, 400, "tailBytes must be a positive integer");
      return;
    }
    try {
      const log = await readTaskLog({ registry: deps.registry, taskId, tailBytes });
      if (!log.found) {
        sendError(res, 404, "Task not found");
        return;
      }
      res.json({
        success: true,
        taskId,
        status: log.status,
        logPath: "logs/run.log",
        available: log.available,
        truncated: log.truncated,
        tailBytes: log.tailBytes,
        content: log.content,
      });
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : "Dashboard log unavailable");
    }
  });

  router.get("/dashboard/tasks/:taskId/agent-trace", async (req, res) => {
    const taskId = Number(req.params.taskId);
    if (!Number.isFinite(taskId)) {
      sendError(res, 404, "Task not found");
      return;
    }
    try {
      const trace = await readTaskAgentTrace({ registry: deps.registry, taskId });
      if (!trace.found) {
        sendError(res, 404, "Task not found");
        return;
      }
      if (!trace.traceAvailable && deps.agentTraceStore) {
        const report = await buildSqliteAgentTraceResponse({
          taskId,
          store: deps.agentTraceStore,
        });
        if (report) {
          res.json({
            success: true,
            taskId,
            traceAvailable: true,
            source: "sqlite",
            report,
            rawAvailable: false,
            message: "完整 trace artifact 不存在，仅展示 SQLite 摘要",
          });
          return;
        }
      }
      res.json({
        success: true,
        taskId,
        traceAvailable: trace.traceAvailable,
        source: trace.source,
        report: trace.report,
        rawAvailable: trace.rawAvailable,
        message: trace.message,
      });
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : "Agent trace unavailable");
    }
  });

  router.get("/dashboard/tasks/:taskId/agent-trace/runs/:traceRunId/raw", async (req, res) => {
    const taskId = Number(req.params.taskId);
    const traceRunId = readString(req.params.traceRunId);
    if (!Number.isFinite(taskId) || !traceRunId) {
      sendError(res, 404, "Agent trace run not found");
      return;
    }
    try {
      const raw = await readTaskAgentTraceRunRaw({
        registry: deps.registry,
        taskId,
        traceRunId,
      });
      if (!raw.found) {
        sendError(res, 404, "Agent trace run not found");
        return;
      }
      res.json({
        success: true,
        taskId,
        traceRunId,
        ...raw.raw,
      });
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : "Agent trace raw unavailable");
    }
  });

  router.get("/dashboard/tasks/:taskId/agent-trace/events/:traceEventId/raw", async (req, res) => {
    const taskId = Number(req.params.taskId);
    const traceEventId = readString(req.params.traceEventId);
    if (!Number.isFinite(taskId) || !traceEventId) {
      sendError(res, 404, "Agent trace event not found");
      return;
    }
    try {
      const raw = await readTaskAgentTraceEventRaw({
        registry: deps.registry,
        taskId,
        traceEventId,
      });
      if (!raw.found) {
        sendError(res, 404, "Agent trace event not found");
        return;
      }
      res.json({
        success: true,
        taskId,
        traceEventId,
        rawPayload: raw.rawPayload,
      });
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : "Agent trace raw unavailable");
    }
  });

  router.get("/dashboard/analysis/human-rating-gaps", async (req, res) => {
    const page = readPositiveInteger(req.query.page, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = readPositiveInteger(req.query.pageSize, 20, 100);
    if (typeof page === "string" || typeof pageSize === "string") {
      sendError(res, 400, "page and pageSize must be positive integers");
      return;
    }
    const manualAnalysisStatus = readManualAnalysisStatus(req.query.manualAnalysisStatus);
    if (manualAnalysisStatus.error) {
      sendError(res, 400, manualAnalysisStatus.error);
      return;
    }
    try {
      const taskSummaries = await getTaskSummaries(deps);
      const taskNameIndex = new Map(taskSummaries.map((task) => [task.taskId, task.name]));
      const dataset = await readHumanRatingGapDataset(deps.humanReviewEvidenceRoot, taskNameIndex);
      const filtered = sortHumanRatingGapsByReviewedAtDesc(
        filterHumanRatingGaps(dataset.items, {
          from: readString(req.query.from),
          to: readString(req.query.to),
          manualRating: readString(req.query.manualRating),
          primaryConclusion: readString(req.query.primaryConclusion),
          keyword: readString(req.query.keyword),
          manualAnalysisStatus: manualAnalysisStatus.status,
        }),
      );
      const paged = paginate(filtered, page, pageSize);
      res.json({
        success: true,
        page,
        pageSize,
        total: paged.total,
        skippedRows: dataset.skippedRows,
        items: paged.items,
      });
    } catch (error) {
      sendError(
        res,
        500,
        error instanceof Error ? error.message : "Dashboard analysis unavailable",
      );
    }
  });

  router.post("/dashboard/analysis/human-rating-gaps/manual-analysis-status", async (req, res) => {
    const body = readBodyRecord(req);
    const status = parseManualStatus(body.status);
    if (!status) {
      sendError(res, 400, "status must be one of pending, analyzed");
      return;
    }
    const taskIds = parseTaskIds(body.taskIds);
    if (!taskIds) {
      sendError(res, 400, "taskIds must be a non-empty array of positive integers");
      return;
    }
    try {
      const result = await updateHumanRatingGapManualAnalysisStatus(
        deps.humanReviewEvidenceRoot,
        taskIds,
        status,
      );
      res.json({ success: true, ...result });
    } catch (error) {
      sendError(
        res,
        500,
        error instanceof Error ? error.message : "Dashboard analysis unavailable",
      );
    }
  });

  router.get("/dashboard/analysis/risk-review-calibrations", async (req, res) => {
    const page = readPositiveInteger(req.query.page, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = readPositiveInteger(req.query.pageSize, 100, 500);
    if (typeof page === "string" || typeof pageSize === "string") {
      sendError(res, 400, "page and pageSize must be positive integers");
      return;
    }
    const agreement = readString(req.query.agreement);
    if (agreement !== undefined && !RISK_REVIEW_AGREEMENTS.has(agreement)) {
      sendError(res, 400, "agreement must be one of agreed, disagreed");
      return;
    }
    const manualAnalysisStatus = readManualAnalysisStatus(req.query.manualAnalysisStatus);
    if (manualAnalysisStatus.error) {
      sendError(res, 400, manualAnalysisStatus.error);
      return;
    }
    try {
      const taskSummaries = await getTaskSummaries(deps);
      const taskNameIndex = new Map(taskSummaries.map((task) => [task.taskId, task.name]));
      const taskCreatedAtById = new Map(taskSummaries.map((task) => [task.taskId, task.createdAt]));
      const dataset = await readRiskReviewCalibrationDataset(
        deps.humanReviewEvidenceRoot,
        taskNameIndex,
      );
      const filtered = sortRiskReviewCalibrationsByTaskTimeDesc(
        filterRiskReviewCalibrations(dataset.items, {
          keyword: readString(req.query.keyword),
          agreement: agreement as "agreed" | "disagreed" | undefined,
          manualAnalysisStatus: manualAnalysisStatus.status,
        }),
        taskCreatedAtById,
      );
      const paged = paginate(filtered, page, pageSize);
      res.json({
        success: true,
        page,
        pageSize,
        total: paged.total,
        skippedRows: dataset.skippedRows,
        items: paged.items,
      });
    } catch (error) {
      sendError(
        res,
        500,
        error instanceof Error ? error.message : "Dashboard analysis unavailable",
      );
    }
  });

  router.post(
    "/dashboard/analysis/risk-review-calibrations/manual-analysis-status",
    async (req, res) => {
      const body = readBodyRecord(req);
      const status = parseManualStatus(body.status);
      if (!status) {
        sendError(res, 400, "status must be one of pending, analyzed");
        return;
      }
      const items = parseRiskStatusItems(body.items);
      if (!items) {
        sendError(res, 400, "items must be a non-empty array");
        return;
      }
      try {
        const result = await updateRiskReviewManualAnalysisStatus(
          deps.humanReviewEvidenceRoot,
          items,
          status,
        );
        res.json({ success: true, ...result });
      } catch (error) {
        sendError(
          res,
          500,
          error instanceof Error ? error.message : "Dashboard analysis unavailable",
        );
      }
    },
  );

  router.get("/dashboard/analysis/negative-results", async (req, res) => {
    try {
      const scoreThreshold = readNumber(req.query.scoreThreshold) ?? 70;
      const taskType = readString(req.query.taskType);
      const from = readString(req.query.from);
      const to = readString(req.query.to);
      const tasks = await getTaskSummaries(deps, { taskType, from, to });
      const ruleRuns = await deps.ruleViolationStatsStore.listRuns();
      res.json({ success: true, ...buildNegativeResults(tasks, ruleRuns, scoreThreshold) });
    } catch (error) {
      sendError(
        res,
        500,
        error instanceof Error ? error.message : "Dashboard analysis unavailable",
      );
    }
  });

  router.get("/dashboard/cross-device/cases", async (req, res) => {
    const query = parseCrossDeviceCaseQuery(req);
    if (typeof query === "string") {
      sendError(res, 400, query);
      return;
    }
    try {
      const tasks = await listCrossDeviceRelatedTasks(deps.registry);
      const filtered = sortCrossDeviceCases(filterCrossDeviceCases(tasks, query), query);
      const page = paginate(filtered, query.page, query.pageSize);
      res.json({
        success: true,
        page: query.page,
        pageSize: query.pageSize,
        total: page.total,
        items: page.items.map(
          ({ officialLinterResults, ruleAuditResults, risks, ...item }) => item,
        ),
      });
    } catch (error) {
      sendError(
        res,
        500,
        error instanceof Error ? error.message : "Dashboard cross-device cases unavailable",
      );
    }
  });

  router.get("/dashboard/cross-device/rule-violations", async (req, res) => {
    const query = parseCrossDeviceRuleQuery(req);
    if (typeof query === "string") {
      sendError(res, 400, query);
      return;
    }
    try {
      const tasks = filterCrossDeviceCases(await listCrossDeviceRelatedTasks(deps.registry), {
        from: query.from,
        to: query.to,
        sortBy: "updatedAt",
        sortOrder: "desc",
      });
      const stats = buildCrossDeviceRuleViolationStats(tasks, query);
      const page = paginate(stats.items, query.page, query.pageSize);
      res.json({
        success: true,
        page: query.page,
        pageSize: query.pageSize,
        total: page.total,
        summary: stats.summary,
        items: page.items,
      });
    } catch (error) {
      sendError(
        res,
        500,
        error instanceof Error ? error.message : "Dashboard cross-device rules unavailable",
      );
    }
  });

  router.get("/dashboard/cross-device/risk-review-calibrations", async (req, res) => {
    const query = parseCrossDeviceRiskQuery(req);
    if (typeof query === "string") {
      sendError(res, 400, query);
      return;
    }
    try {
      const tasks = filterCrossDeviceCases(await listCrossDeviceRelatedTasks(deps.registry), {
        from: query.from,
        to: query.to,
        sortBy: "updatedAt",
        sortOrder: "desc",
      });
      const relatedTaskIds = new Set(tasks.map((task) => task.taskId));
      const taskNameIndex = new Map(tasks.map((task) => [task.taskId, task.name]));
      const dataset = await readCrossDeviceRiskReviewDataset({
        root: deps.humanReviewEvidenceRoot,
        relatedTaskIds,
        taskNames: taskNameIndex,
      });
      const filtered = filterCrossDeviceRiskReviews(dataset.items, query);
      const page = paginate(filtered, query.page, query.pageSize);
      res.json({
        success: true,
        page: query.page,
        pageSize: query.pageSize,
        total: page.total,
        skippedRows: dataset.skippedRows,
        items: page.items,
      });
    } catch (error) {
      sendError(
        res,
        500,
        error instanceof Error ? error.message : "Dashboard cross-device risks unavailable",
      );
    }
  });

  return router;
}

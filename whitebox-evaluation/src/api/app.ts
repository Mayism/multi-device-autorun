import fs from "node:fs/promises";
import path from "node:path";
import express, { NextFunction, Request, Response } from "express";
import { API_PATHS } from "../interfaces/http/apiDefinitions.js";
import { getConfig } from "../config.js";
import {
  createConsistencyTaskStore,
  type ConsistencyTaskRecord,
  type ConsistencyTaskStore,
} from "./consistencyTaskStore.js";
import { createSubmitHumanReviewHandler } from "./humanReviewHandler.js";
import type {
  RemoteTaskRecord as StoredRemoteTaskRecord,
  RemoteTaskRegistry,
} from "./remoteTaskRegistry.js";
import { uploadTaskCallback } from "../commons/io/uploader.js";
import {
  createHumanReviewEvidenceStore,
  type HumanReviewEvidenceStore,
} from "../datasets/humanReview/humanReviewEvidenceStore.js";
import {
  buildRuleViolationStatsResponse,
  createRuleViolationStatsStore,
  extractRuleViolationRunSnapshot,
  validateRuleViolationStatsQuery,
  type RuleViolationStatsQuery,
  type RuleViolationStatsStore,
} from "./ruleViolationStatsStore.js";
import {
  REMOTE_TASK_PAYLOAD_FILE,
  acceptRemoteEvaluationTask,
  executeAcceptedRemoteEvaluationTask,
  prepareRemoteEvaluationTask,
  replayCompletedRemoteTaskCallback,
  restoreAcceptedRemoteEvaluationTask,
} from "../service/index.js";
import type { RemoteEvaluationTask } from "../types.js";
import { createDashboardRouter } from "../datasets/dashboard/dashboardHandlers.js";
import { createAgentTraceSqliteStore } from "../agents/trace/sqliteStore.js";
import type { AgentTraceReport } from "../agents/trace/types.js";
import { createScoreDatabase } from "../datasets/sqlite/database.js";
import { backfillSqliteIndexes } from "../datasets/sqlite/backfill.js";
import {
  createSqliteConsistencyTaskStore,
  createSqliteRemoteTaskRegistry,
  createSqliteRuleViolationStatsStore,
  buildSqliteRuleViolationStatsResponse,
  countSqliteRemoteTaskStatuses,
  listSqliteRemoteTaskPage,
  listSqliteRemoteTaskSummariesForRange,
  summarizeSqliteRemoteTasks,
  updateSqliteRemoteTaskSummary,
} from "../datasets/sqlite/stores.js";

type AppDeps = {
  acceptRemoteEvaluationTask: typeof acceptRemoteEvaluationTask;
  prepareRemoteEvaluationTask: typeof prepareRemoteEvaluationTask;
  executeAcceptedRemoteEvaluationTask: typeof executeAcceptedRemoteEvaluationTask;
};

type RemoteTaskSummaryStore = {
  updateTaskSummary(input: {
    taskId: number;
    caseName?: string;
    taskType?: string;
    score?: number | null;
    hardGateTriggered?: boolean | null;
    resultAvailable: boolean;
    resultError?: string;
    risks?: Array<{ level?: string; title?: string }>;
  }): void;
  updateAgentTrace?(input: { taskId: number; caseDir: string }): Promise<void> | void;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readScore(resultJson: Record<string, unknown>): number | null {
  const score = asRecord(resultJson.overall_conclusion)?.total_score;
  return typeof score === "number" && Number.isFinite(score) ? score : null;
}

function readHardGate(resultJson: Record<string, unknown>): boolean | null {
  const hardGate = asRecord(resultJson.overall_conclusion)?.hard_gate_triggered;
  return typeof hardGate === "boolean" ? hardGate : null;
}

function readCaseName(resultJson: Record<string, unknown>): string | undefined {
  const basicInfo = asRecord(resultJson.basic_info);
  const caseName = basicInfo?.case_name ?? basicInfo?.name;
  return typeof caseName === "string" && caseName.trim().length > 0 ? caseName : undefined;
}

function readTaskTypeFromResult(resultJson: Record<string, unknown>): string | undefined {
  const taskType = asRecord(resultJson.basic_info)?.task_type;
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

function hasStoredSourceTask(record: ConsistencyTaskRecord): boolean {
  return asRecord(record.sourceTask) !== undefined;
}

function readConsistencyOriginalTaskId(record: ConsistencyTaskRecord): number | undefined {
  const taskId = record.originalTaskId;
  return typeof taskId === "number" && Number.isSafeInteger(taskId) && taskId > 0
    ? taskId
    : undefined;
}

function resolveRemoteTaskPayloadPath(record: StoredRemoteTaskRecord): string | undefined {
  if (!record.caseDir || !record.remoteTaskFile) {
    return undefined;
  }
  return path.isAbsolute(record.remoteTaskFile)
    ? record.remoteTaskFile
    : path.join(record.caseDir, record.remoteTaskFile);
}

async function readStoredRemoteTaskPayload(
  record: StoredRemoteTaskRecord,
): Promise<unknown | undefined> {
  const payloadPath = resolveRemoteTaskPayloadPath(record);
  if (!payloadPath) {
    return undefined;
  }
  const text = await fs.readFile(payloadPath, "utf-8");
  return JSON.parse(text) as unknown;
}

type AcceptedRemoteEvaluationTask = Parameters<AppDeps["executeAcceptedRemoteEvaluationTask"]>[0];

type RemoteTaskRecordStatus =
  | "preparing"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timed_out";

type RemoteTaskRecord = {
  taskId: number;
  status: RemoteTaskRecordStatus;
  createdAt: number;
  updatedAt: number;
  caseDir?: string;
  token?: string;
  testCaseId?: number;
  testCaseName?: string;
  testCaseType?: string;
  error?: string;
  remoteTaskFile?: string;
  recoveryAttemptCount?: number;
  lastRecoveryAt?: number;
};

type RemoteTaskLogContext = {
  taskId?: number;
  testCaseId?: number;
};

const MAX_REMOTE_TASK_CONCURRENCY = 3;

function resolveRemoteTaskConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const rawValue = env.HMOS_REMOTE_TASK_CONCURRENCY;
  if (rawValue === undefined || rawValue.trim() === "") {
    return MAX_REMOTE_TASK_CONCURRENCY;
  }
  const parsed = Number(rawValue);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : MAX_REMOTE_TASK_CONCURRENCY;
}

function readTaskId(body: unknown): number | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const taskId = (body as { taskId?: unknown }).taskId;
  return typeof taskId === "number" && Number.isFinite(taskId) ? taskId : undefined;
}

function readRemoteTestCaseId(body: unknown): number | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const testCase = (body as { testCase?: unknown }).testCase;
  if (typeof testCase !== "object" || testCase === null) {
    return undefined;
  }
  const testCaseId = (testCase as { id?: unknown }).id;
  return typeof testCaseId === "number" && Number.isFinite(testCaseId) ? testCaseId : undefined;
}

function readRemoteTestCaseString(body: unknown, key: "name" | "type"): string | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const testCase = (body as { testCase?: unknown }).testCase;
  if (typeof testCase !== "object" || testCase === null) {
    return undefined;
  }
  const value = (testCase as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatRemoteLogContext(context: RemoteTaskLogContext): string {
  return `taskId=${String(context.taskId ?? "unknown")} testCaseId=${String(context.testCaseId ?? "unknown")}`;
}

function formatAcceptedTaskLogContext(acceptedTask: AcceptedRemoteEvaluationTask): string {
  return formatRemoteLogContext({
    taskId: acceptedTask.taskId,
    testCaseId: acceptedTask.remoteTask.testCase.id,
  });
}

function logRemoteApiTriggered(context: RemoteTaskLogContext): void {
  console.info(
    `api_request_triggered route=POST /score/run-remote-task ${formatRemoteLogContext(context)}`,
  );
}

function logRemoteApiFailed(context: RemoteTaskLogContext, error: unknown): void {
  console.error(
    `api_request_failed route=POST /score/run-remote-task ${formatRemoteLogContext(context)} error=${formatError(error)}`,
  );
}

function sendRemoteApiResponse(
  res: Response,
  status: number,
  context: RemoteTaskLogContext,
  body: Record<string, unknown>,
): void {
  console.info(
    `api_response_sent route=POST /score/run-remote-task ${formatRemoteLogContext(context)} status=${String(status)} success=${String(body.success)}`,
  );
  if (status === 200) {
    res.json(body);
    return;
  }
  res.status(status).json(body);
}

async function uploadQueuedPendingCallback(
  acceptedTask: AcceptedRemoteEvaluationTask,
): Promise<void> {
  const upload = await uploadTaskCallback(
    acceptedTask.remoteTask.callback,
    acceptedTask.remoteTask.token,
    {
      taskId: acceptedTask.taskId,
      status: "pending",
    },
  );
  console.info(
    `queued_remote_task_callback_sent ${formatAcceptedTaskLogContext(acceptedTask)} status=pending uploaded=${String(upload.uploaded)} message=${upload.message}`,
  );
}

export function createRunRemoteTaskHandler(
  deps: AppDeps,
  registry?: RemoteTaskRegistry,
  ruleViolationStatsStore?: RuleViolationStatsStore,
  humanReviewEvidenceStore?: HumanReviewEvidenceStore,
  queue = createRemoteTaskExecutionQueue(
    deps,
    registry,
    ruleViolationStatsStore,
    humanReviewEvidenceStore,
    undefined,
  ),
) {
  function buildAcceptedTaskLogContext(
    acceptedTask: AcceptedRemoteEvaluationTask,
  ): RemoteTaskLogContext {
    return {
      taskId: acceptedTask.taskId,
      testCaseId: acceptedTask.remoteTask.testCase.id,
    };
  }

  return async (req: Request, res: Response) => {
    const taskId = readTaskId(req.body);
    const requestLogContext: RemoteTaskLogContext = {
      taskId,
      testCaseId: readRemoteTestCaseId(req.body),
    };
    logRemoteApiTriggered(requestLogContext);
    try {
      if (taskId !== undefined) {
        queue.upsertTaskRecord(taskId, "preparing", {
          token: typeof req.body?.token === "string" ? req.body.token : undefined,
          testCaseId: readRemoteTestCaseId(req.body),
          testCaseName: readRemoteTestCaseString(req.body, "name"),
          testCaseType: readRemoteTestCaseString(req.body, "type"),
        });
      }
      const acceptedTask = await deps.acceptRemoteEvaluationTask(req.body as RemoteEvaluationTask);
      const acceptedTaskLogContext = buildAcceptedTaskLogContext(acceptedTask);
      queue.upsertTaskRecord(acceptedTask.taskId, "preparing", {
        caseDir: acceptedTask.caseDir,
        token: acceptedTask.remoteTask.token,
        testCaseId: acceptedTask.remoteTask.testCase.id,
        testCaseName: acceptedTask.remoteTask.testCase.name,
        testCaseType: acceptedTask.remoteTask.testCase.type,
        remoteTaskFile: REMOTE_TASK_PAYLOAD_FILE,
      });
      const executionPromise = queue.enqueueRemoteTaskExecution(acceptedTask);
      const shouldUploadQueuedPendingCallback = queue.isQueued(acceptedTask.taskId);
      void executionPromise.catch((error) => {
        console.error(
          `run-remote-task background execution failed ${formatRemoteLogContext(acceptedTaskLogContext)} error=${formatError(error)}`,
        );
      });
      sendRemoteApiResponse(res, 200, acceptedTaskLogContext, {
        success: true,
        taskId: acceptedTask.taskId,
        message: acceptedTask.message,
      });
      if (shouldUploadQueuedPendingCallback) {
        void uploadQueuedPendingCallback(acceptedTask).catch((error) => {
          console.error(
            `queued_remote_task_callback_failed ${formatAcceptedTaskLogContext(acceptedTask)} error=${formatError(error)}`,
          );
        });
      }
    } catch (error) {
      if (taskId !== undefined) {
        queue.upsertTaskRecord(taskId, "failed", { error: formatError(error) });
      }
      logRemoteApiFailed(requestLogContext, error);
      sendRemoteApiResponse(res, 500, requestLogContext, {
        success: false,
        message: error instanceof Error ? error.message : "未知错误",
      });
    }
  };
}

export function createRemoteTaskExecutionQueue(
  deps: AppDeps,
  registry?: RemoteTaskRegistry,
  ruleViolationStatsStore?: RuleViolationStatsStore,
  _humanReviewEvidenceStore?: HumanReviewEvidenceStore,
  remoteTaskSummaryStore?: RemoteTaskSummaryStore,
  options: { maxRemoteTaskConcurrency?: number } = {},
) {
  const maxRemoteTaskConcurrency =
    options.maxRemoteTaskConcurrency ?? resolveRemoteTaskConcurrency();
  const runningTaskIds = new Set<number>();
  const queuedTaskIds = new Set<number>();
  const remoteTaskRecords = new Map<number, RemoteTaskRecord>();
  const pendingRemoteTaskExecutions: Array<{
    acceptedTask: AcceptedRemoteEvaluationTask;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];

  function upsertTaskRecord(
    taskId: number,
    status: RemoteTaskRecordStatus,
    patch: Partial<Omit<RemoteTaskRecord, "taskId" | "createdAt" | "updatedAt" | "status">> = {},
  ): RemoteTaskRecord {
    const existing = remoteTaskRecords.get(taskId);
    const now = Date.now();
    const record: RemoteTaskRecord = {
      taskId,
      status,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      caseDir: patch.caseDir ?? existing?.caseDir,
      token: patch.token ?? existing?.token,
      testCaseId: patch.testCaseId ?? existing?.testCaseId,
      testCaseName: patch.testCaseName ?? existing?.testCaseName,
      testCaseType: patch.testCaseType ?? existing?.testCaseType,
      error: patch.error ?? existing?.error,
      remoteTaskFile: patch.remoteTaskFile ?? existing?.remoteTaskFile,
      recoveryAttemptCount: patch.recoveryAttemptCount ?? existing?.recoveryAttemptCount,
      lastRecoveryAt: patch.lastRecoveryAt ?? existing?.lastRecoveryAt,
    };
    remoteTaskRecords.set(taskId, record);
    if (registry) {
      void registry
        .upsert({
          taskId: record.taskId,
          status: record.status,
          caseDir: record.caseDir,
          token: record.token,
          testCaseId: record.testCaseId,
          testCaseName: record.testCaseName,
          testCaseType: record.testCaseType,
          error: record.error,
          remoteTaskFile: record.remoteTaskFile,
          recoveryAttemptCount: record.recoveryAttemptCount,
          lastRecoveryAt: record.lastRecoveryAt,
        })
        .catch((error) => {
          console.error(
            `remote_task_registry_update_failed ${formatRemoteLogContext({ taskId: record.taskId, testCaseId: record.testCaseId })} error=${formatError(error)}`,
          );
        });
    }
    return record;
  }

  function isExecutingOrQueued(taskId: number): boolean {
    const status = remoteTaskRecords.get(taskId)?.status;
    return (
      runningTaskIds.has(taskId) ||
      queuedTaskIds.has(taskId) ||
      status === "running" ||
      status === "queued"
    );
  }

  async function executeRemoteTask(acceptedTask: AcceptedRemoteEvaluationTask): Promise<void> {
    queuedTaskIds.delete(acceptedTask.taskId);
    runningTaskIds.add(acceptedTask.taskId);
    upsertTaskRecord(acceptedTask.taskId, "running", {
      caseDir: acceptedTask.caseDir,
      token: acceptedTask.remoteTask.token,
      testCaseId: acceptedTask.remoteTask.testCase.id,
      testCaseName: acceptedTask.remoteTask.testCase.name,
      testCaseType: acceptedTask.remoteTask.testCase.type,
      remoteTaskFile: REMOTE_TASK_PAYLOAD_FILE,
    });
    try {
      await deps.executeAcceptedRemoteEvaluationTask(acceptedTask, {
        onCompleted: ruleViolationStatsStore
          ? async ({ acceptedTask: completedTask, workflowResult, resultJson }) => {
              remoteTaskSummaryStore?.updateTaskSummary({
                taskId: completedTask.taskId,
                caseName: readCaseName(resultJson),
                taskType: readTaskTypeFromResult(resultJson),
                score: readScore(resultJson),
                hardGateTriggered: readHardGate(resultJson),
                resultAvailable: true,
                risks: readRisks(resultJson),
              });
              await remoteTaskSummaryStore?.updateAgentTrace?.({
                taskId: completedTask.taskId,
                caseDir: completedTask.caseDir,
              });
              await ruleViolationStatsStore.upsertRun(
                extractRuleViolationRunSnapshot({
                  taskId: completedTask.taskId,
                  caseId:
                    typeof workflowResult.caseInput === "object" &&
                    workflowResult.caseInput !== null
                      ? String((workflowResult.caseInput as { caseId?: unknown }).caseId ?? "")
                      : String(completedTask.remoteTask.testCase.id),
                  testCaseId: completedTask.remoteTask.testCase.id,
                  caseName: completedTask.remoteTask.testCase.name,
                  boundRulePacks: Array.isArray(resultJson.bound_rule_packs)
                    ? (resultJson.bound_rule_packs as Array<{
                        pack_id?: unknown;
                        display_name?: unknown;
                      }>)
                    : [],
                  ruleAuditResults: Array.isArray(resultJson.rule_audit_results)
                    ? (resultJson.rule_audit_results as never)
                    : [],
                }),
              );
            }
          : undefined,
      });
      upsertTaskRecord(acceptedTask.taskId, "completed", {
        caseDir: acceptedTask.caseDir,
        token: acceptedTask.remoteTask.token,
        testCaseId: acceptedTask.remoteTask.testCase.id,
        testCaseName: acceptedTask.remoteTask.testCase.name,
        testCaseType: acceptedTask.remoteTask.testCase.type,
        remoteTaskFile: REMOTE_TASK_PAYLOAD_FILE,
      });
    } catch (error) {
      upsertTaskRecord(acceptedTask.taskId, "failed", {
        caseDir: acceptedTask.caseDir,
        token: acceptedTask.remoteTask.token,
        testCaseId: acceptedTask.remoteTask.testCase.id,
        testCaseName: acceptedTask.remoteTask.testCase.name,
        testCaseType: acceptedTask.remoteTask.testCase.type,
        remoteTaskFile: REMOTE_TASK_PAYLOAD_FILE,
        error: formatError(error),
      });
      throw error;
    } finally {
      runningTaskIds.delete(acceptedTask.taskId);
      scheduleRemoteTaskExecutions();
    }
  }

  function scheduleRemoteTaskExecutions(): void {
    while (
      runningTaskIds.size < maxRemoteTaskConcurrency &&
      pendingRemoteTaskExecutions.length > 0
    ) {
      const pending = pendingRemoteTaskExecutions.shift();
      if (!pending) {
        return;
      }
      void executeRemoteTask(pending.acceptedTask).then(pending.resolve, pending.reject);
    }
  }

  function enqueueRemoteTaskExecution(acceptedTask: AcceptedRemoteEvaluationTask): Promise<void> {
    queuedTaskIds.add(acceptedTask.taskId);
    upsertTaskRecord(acceptedTask.taskId, "queued", {
      caseDir: acceptedTask.caseDir,
      token: acceptedTask.remoteTask.token,
      testCaseId: acceptedTask.remoteTask.testCase.id,
      testCaseName: acceptedTask.remoteTask.testCase.name,
      testCaseType: acceptedTask.remoteTask.testCase.type,
      remoteTaskFile: REMOTE_TASK_PAYLOAD_FILE,
    });
    return new Promise<void>((resolve, reject) => {
      pendingRemoteTaskExecutions.push({ acceptedTask, resolve, reject });
      scheduleRemoteTaskExecutions();
    });
  }

  async function recoverPendingRemoteTasks(): Promise<void> {
    if (!registry) {
      return;
    }
    const records = await registry.list();
    for (const record of records) {
      if (!["preparing", "queued", "running"].includes(record.status)) {
        continue;
      }
      if (!record.caseDir) {
        await registry.upsert({
          taskId: record.taskId,
          status: "failed",
          error: "missing persisted caseDir",
        });
        continue;
      }
      const remoteTaskFile = record.remoteTaskFile ?? REMOTE_TASK_PAYLOAD_FILE;
      const recoveryAttemptCount = (record.recoveryAttemptCount ?? 0) + 1;
      const lastRecoveryAt = Date.now();
      await registry.upsert({
        taskId: record.taskId,
        status: record.status,
        caseDir: record.caseDir,
        remoteTaskFile,
        recoveryAttemptCount,
        lastRecoveryAt,
      });

      try {
        await fs.access(path.join(record.caseDir, "outputs", "result.json"));
        await replayCompletedRemoteTaskCallback({
          taskId: record.taskId,
          caseDir: record.caseDir,
          remoteTaskFile,
        });
        await registry.upsert({
          taskId: record.taskId,
          status: "completed",
          caseDir: record.caseDir,
          testCaseId: record.testCaseId,
          testCaseName: record.testCaseName,
          testCaseType: record.testCaseType,
          token: record.token,
          remoteTaskFile,
          recoveryAttemptCount,
          lastRecoveryAt,
        });
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          await registry.upsert({
            taskId: record.taskId,
            status: "failed",
            caseDir: record.caseDir,
            testCaseId: record.testCaseId,
            testCaseName: record.testCaseName,
            testCaseType: record.testCaseType,
            token: record.token,
            remoteTaskFile,
            error: formatError(error),
            recoveryAttemptCount,
            lastRecoveryAt,
          });
          continue;
        }
      }

      try {
        const acceptedTask = await restoreAcceptedRemoteEvaluationTask({
          taskId: record.taskId,
          caseDir: record.caseDir,
          remoteTaskFile,
        });
        void enqueueRemoteTaskExecution(acceptedTask).catch((error) => {
          console.error(
            `remote_task_recovery_execution_failed ${formatRemoteLogContext({ taskId: record.taskId, testCaseId: record.testCaseId })} error=${formatError(error)}`,
          );
        });
      } catch (error) {
        await registry.upsert({
          taskId: record.taskId,
          status: "failed",
          caseDir: record.caseDir,
          testCaseId: record.testCaseId,
          testCaseName: record.testCaseName,
          testCaseType: record.testCaseType,
          token: record.token,
          remoteTaskFile,
          error: `missing persisted remote task file: ${formatError(error)}`,
          recoveryAttemptCount,
          lastRecoveryAt,
        });
      }
    }
  }

  return {
    enqueueRemoteTaskExecution,
    recoverPendingRemoteTasks,
    upsertTaskRecord,
    isExecutingOrQueued,
    isQueued(taskId: number): boolean {
      return queuedTaskIds.has(taskId);
    },
  };
}

function readRouteTaskId(req: Request): number | undefined {
  const value = req.params.taskId;
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const taskId = Number(value);
  return Number.isFinite(taskId) ? taskId : undefined;
}

function readOptionalQueryString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
}

function readRemoteTaskStatusIds(req: Request): number[] | string {
  const taskIdsText = readOptionalQueryString(req.query.taskIds);
  if (!taskIdsText) {
    return "Invalid query parameter: taskIds must be comma-separated positive integers";
  }

  const taskIds = taskIdsText.split(",").map((value) => Number(value.trim()));
  if (
    taskIds.length === 0 ||
    taskIds.length > 50 ||
    !taskIds.every((taskId) => Number.isSafeInteger(taskId) && taskId > 0)
  ) {
    return "Invalid query parameter: taskIds must be comma-separated positive integers";
  }
  return taskIds;
}

function readConsistencyRunTaskIds(record: ConsistencyTaskRecord): number[] {
  const ids = new Set<number>();
  const addRuns = (runs: unknown) => {
    if (!Array.isArray(runs)) {
      return;
    }
    for (const run of runs) {
      const taskId =
        typeof run === "object" && run !== null ? (run as { taskId?: unknown }).taskId : undefined;
      if (Number.isSafeInteger(taskId) && Number(taskId) > 0) {
        ids.add(Number(taskId));
      }
    }
  };

  addRuns(record.runs);
  const history = record.analysisHistory;
  if (Array.isArray(history)) {
    for (const item of history) {
      if (typeof item === "object" && item !== null) {
        addRuns((item as { runs?: unknown }).runs);
      }
    }
  }
  return [...ids];
}

function isConsistencyTaskRecord(value: unknown): value is ConsistencyTaskRecord {
  const record = value as { id?: unknown; sequence?: unknown };
  return (
    typeof value === "object" &&
    value !== null &&
    typeof record.id === "string" &&
    record.id.trim().length > 0 &&
    typeof record.sequence === "number" &&
    Number.isFinite(record.sequence)
  );
}

function readConsistencyTaskRecords(req: Request): ConsistencyTaskRecord[] | string {
  const items = (req.body as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items) || !items.every(isConsistencyTaskRecord)) {
    return "Invalid request body: items must be consistency task records";
  }
  return items;
}

function readConsistencyTaskRecord(req: Request): ConsistencyTaskRecord | string {
  const body = req.body as unknown;
  if (!isConsistencyTaskRecord(body)) {
    return "Invalid request body: consistency task record is required";
  }

  const taskId = req.params.id;
  if (typeof taskId !== "string" || taskId.trim().length === 0) {
    return "Invalid path parameter: id is required";
  }
  if (body.id !== taskId) {
    return "Invalid request body: id does not match path parameter";
  }

  return body;
}

type ConsistencyTaskPatch = {
  updatedAt?: string;
  status?: string;
  replaceRuns?: boolean;
  runs?: Array<Record<string, unknown>>;
  analysisHistory?: Array<Record<string, unknown>>;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConsistencyTaskPatch(value: unknown): value is ConsistencyTaskPatch {
  if (!isObjectRecord(value)) {
    return false;
  }
  const patch = value as ConsistencyTaskPatch;
  return (
    (patch.updatedAt === undefined || typeof patch.updatedAt === "string") &&
    (patch.status === undefined || typeof patch.status === "string") &&
    (patch.replaceRuns === undefined || typeof patch.replaceRuns === "boolean") &&
    (patch.runs === undefined || (Array.isArray(patch.runs) && patch.runs.every(isObjectRecord))) &&
    (patch.analysisHistory === undefined ||
      (Array.isArray(patch.analysisHistory) && patch.analysisHistory.every(isObjectRecord)))
  );
}

function readConsistencyTaskPatch(req: Request): ConsistencyTaskPatch | string {
  const { id } = req.params as { id?: unknown };
  if (typeof id !== "string" || id.trim().length === 0) {
    return "Invalid path parameter: id is required";
  }
  const body = req.body as unknown;
  if (!isConsistencyTaskPatch(body)) {
    return "Invalid request body: consistency task patch is required";
  }
  return body;
}

function mergeConsistencyTaskPatch(
  existing: ConsistencyTaskRecord,
  patch: ConsistencyTaskPatch,
): ConsistencyTaskRecord {
  const merged: ConsistencyTaskRecord = { ...existing };
  if (patch.updatedAt !== undefined) {
    merged.updatedAt = patch.updatedAt;
  }
  if (patch.status !== undefined) {
    merged.status = patch.status;
  }

  if (patch.runs !== undefined) {
    const runs = patch.replaceRuns ? [] : Array.isArray(existing.runs) ? [...existing.runs] : [];
    const runIndexes = new Map<number, number>();
    runs.forEach((run, index) => {
      if (isObjectRecord(run) && Number.isSafeInteger(run.taskId)) {
        runIndexes.set(Number(run.taskId), index);
      }
    });
    for (const run of patch.runs) {
      if (!Number.isSafeInteger(run.taskId)) {
        continue;
      }
      const index = runIndexes.get(Number(run.taskId));
      if (index === undefined) {
        runIndexes.set(Number(run.taskId), runs.length);
        runs.push(run);
      } else {
        runs[index] = run;
      }
    }
    merged.runs = compactRunRecordsByRunIndex(runs);
  }

  if (patch.analysisHistory !== undefined) {
    const history = Array.isArray(existing.analysisHistory) ? [...existing.analysisHistory] : [];
    const historyKeys = new Set(
      history
        .filter(isObjectRecord)
        .map((item) => `${String(item.round)}:${String(item.capturedAt)}`),
    );
    for (const item of patch.analysisHistory) {
      const key = `${String(item.round)}:${String(item.capturedAt)}`;
      if (!historyKeys.has(key)) {
        historyKeys.add(key);
        history.push(item);
      }
    }
    merged.analysisHistory = history;
  }

  return merged;
}

function compactRunRecordsByRunIndex(
  runs: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const indexedRuns = new Map<number, Record<string, unknown>>();
  const unindexedRuns: Array<Record<string, unknown>> = [];
  for (const run of runs) {
    if (Number.isSafeInteger(run.runIndex)) {
      indexedRuns.set(Number(run.runIndex), run);
    } else {
      unindexedRuns.push(run);
    }
  }
  return [
    ...[...indexedRuns.values()].sort(
      (left, right) => Number(left.runIndex) - Number(right.runIndex),
    ),
    ...unindexedRuns,
  ];
}

function readRuleViolationStatsQuery(req: Request): RuleViolationStatsQuery | string {
  const testCaseIdText = readOptionalQueryString(req.query.testCaseId);
  const testCaseId = testCaseIdText === undefined ? undefined : Number(testCaseIdText);
  if (testCaseIdText !== undefined && !Number.isFinite(testCaseId)) {
    return "Invalid query parameter: testCaseId must be a number";
  }

  const query: RuleViolationStatsQuery = {
    caseId: readOptionalQueryString(req.query.caseId),
    testCaseId,
    packId: readOptionalQueryString(req.query.packId),
    from: readOptionalQueryString(req.query.from),
    to: readOptionalQueryString(req.query.to),
  };
  const validationError = validateRuleViolationStatsQuery(query);
  return validationError ?? query;
}

function sanitizeRemoteTaskResultData(resultData: unknown): unknown {
  if (typeof resultData !== "object" || resultData === null || Array.isArray(resultData)) {
    return resultData;
  }

  const { testExecution: _testExecution, ...publicResultData } = resultData as Record<
    string,
    unknown
  >;
  return publicResultData;
}

export function createGetRuleViolationStatsHandler(store: RuleViolationStatsStore) {
  return async (req: Request, res: Response) => {
    const query = readRuleViolationStatsQuery(req);
    if (typeof query === "string") {
      res.status(400).json({ success: false, message: query });
      return;
    }

    try {
      const runs = await store.listRuns();
      res.json(buildRuleViolationStatsResponse(runs, query));
    } catch (error) {
      console.error(`rule_violation_stats_read_failed error=${formatError(error)}`);
      res.status(500).json({ success: false, message: "Rule violation stats are unavailable" });
    }
  };
}

export function createGetSqliteRuleViolationStatsHandler(
  buildResponse: (
    query: RuleViolationStatsQuery,
  ) => ReturnType<typeof buildSqliteRuleViolationStatsResponse>,
) {
  return async (req: Request, res: Response) => {
    const query = readRuleViolationStatsQuery(req);
    if (typeof query === "string") {
      res.status(400).json({ success: false, message: query });
      return;
    }

    try {
      res.json(buildResponse(query));
    } catch (error) {
      console.error(`rule_violation_stats_read_failed error=${formatError(error)}`);
      res.status(500).json({ success: false, message: "Rule violation stats are unavailable" });
    }
  };
}

function buildUnavailableRemoteTaskResultBody(taskId: number, record: StoredRemoteTaskRecord) {
  if (record.status === "failed") {
    return {
      success: false,
      taskId,
      status: record.status,
      message: "Remote task execution failed",
      ...(record.error ? { error: record.error } : {}),
      resultAvailable: false,
      terminal: true,
    };
  }
  if (record.status === "timed_out") {
    return {
      success: false,
      taskId,
      status: record.status,
      message: "Remote task execution timed out",
      ...(record.error ? { error: record.error } : {}),
      resultAvailable: false,
      terminal: true,
    };
  }
  return {
    success: false,
    taskId,
    status: record.status,
    message: "Result is not available yet",
    resultAvailable: false,
    terminal: false,
  };
}

export function createGetRemoteTaskResultHandler(registry: RemoteTaskRegistry) {
  return async (req: Request, res: Response) => {
    const taskId = readRouteTaskId(req);
    if (taskId === undefined) {
      res.status(404).json({ success: false, message: "Remote task not found" });
      return;
    }

    const record = await registry.get(taskId);
    if (!record) {
      res.status(404).json({ success: false, taskId, message: "Remote task not found" });
      return;
    }

    if (record.status !== "completed") {
      res.status(409).json(buildUnavailableRemoteTaskResultBody(taskId, record));
      return;
    }

    if (!record.caseDir) {
      res.status(404).json({
        success: false,
        taskId,
        status: record.status,
        message: "Result file not found",
      });
      return;
    }

    try {
      const resultText = await fs.readFile(
        path.join(record.caseDir, "outputs", "result.json"),
        "utf-8",
      );
      const resultData = sanitizeRemoteTaskResultData(JSON.parse(resultText) as unknown);
      res.json({
        success: true,
        taskId,
        status: record.status,
        resultData,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(404).json({
          success: false,
          taskId,
          status: record.status,
          message: "Result file not found",
        });
        return;
      }
      throw error;
    }
  };
}

export function createGetRemoteTaskRawResultHandler(registry: RemoteTaskRegistry) {
  return async (req: Request, res: Response) => {
    const taskId = readRouteTaskId(req);
    if (taskId === undefined) {
      res.status(404).json({ success: false, message: "Remote task not found" });
      return;
    }

    const record = await registry.get(taskId);
    if (!record) {
      res.status(404).json({ success: false, taskId, message: "Remote task not found" });
      return;
    }

    if (record.status !== "completed") {
      res.status(409).json(buildUnavailableRemoteTaskResultBody(taskId, record));
      return;
    }

    if (!record.caseDir) {
      res.status(404).json({
        success: false,
        taskId,
        status: record.status,
        message: "Result file not found",
      });
      return;
    }

    try {
      const resultText = await fs.readFile(
        path.join(record.caseDir, "outputs", "result.json"),
        "utf-8",
      );
      res
        .type("application/json")
        .set("Content-Disposition", `attachment; filename="task-${String(taskId)}-result.json"`)
        .send(resultText);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(404).json({
          success: false,
          taskId,
          status: record.status,
          message: "Result file not found",
        });
        return;
      }
      throw error;
    }
  };
}

export function createGetRemoteTaskStatusesHandler(registry: RemoteTaskRegistry) {
  return async (req: Request, res: Response) => {
    const taskIds = readRemoteTaskStatusIds(req);
    if (typeof taskIds === "string") {
      res.status(400).json({ success: false, message: taskIds });
      return;
    }

    const items = await Promise.all(
      taskIds.map(async (taskId) => {
        const record = await registry.get(taskId);
        if (!record) {
          return {
            taskId,
            status: "missing",
            resultAvailable: false,
            message: "Remote task not found",
          };
        }
        return {
          taskId: record.taskId,
          status: record.status,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          ...(record.testCaseId !== undefined ? { testCaseId: record.testCaseId } : {}),
          ...(record.testCaseName ? { testCaseName: record.testCaseName } : {}),
          resultAvailable: record.status === "completed",
          ...(record.error ? { error: record.error } : {}),
        };
      }),
    );

    res.json({ success: true, items });
  };
}

async function deleteRemoteTaskWithArtifacts(
  registry: Pick<RemoteTaskRegistry, "delete" | "get">,
  taskId: number,
): Promise<boolean> {
  const record = await registry.get(taskId);
  if (!record) {
    return false;
  }
  if (record.caseDir) {
    await fs.rm(record.caseDir, { recursive: true, force: true });
  }
  return await registry.delete(taskId);
}

export function createDeleteRemoteTasksHandler(
  registry: Pick<RemoteTaskRegistry, "delete" | "get">,
) {
  return async (req: Request, res: Response) => {
    const taskIds = readRemoteTaskStatusIds(req);
    if (typeof taskIds === "string") {
      res.status(400).json({ success: false, message: taskIds });
      return;
    }

    const deletedTaskIds: number[] = [];
    for (const taskId of taskIds) {
      if (await deleteRemoteTaskWithArtifacts(registry, taskId)) {
        deletedTaskIds.push(taskId);
      }
    }

    res.json({ success: true, deletedTaskIds });
  };
}

export function createGetConsistencyTasksHandler(
  store: ConsistencyTaskStore,
  options: { sourceTaskRegistry?: Pick<RemoteTaskRegistry, "get"> } = {},
) {
  return async (_req: Request, res: Response) => {
    try {
      const records = await store.list();
      const items = await Promise.all(
        records.map(async (record) => {
          if (hasStoredSourceTask(record)) {
            return record;
          }
          const originalTaskId = readConsistencyOriginalTaskId(record);
          if (!originalTaskId || !options.sourceTaskRegistry) {
            return record;
          }
          const remoteTask = await options.sourceTaskRegistry.get(originalTaskId);
          if (!remoteTask) {
            return record;
          }
          try {
            const sourceTask = await readStoredRemoteTaskPayload(remoteTask);
            return sourceTask === undefined ? record : { ...record, sourceTask };
          } catch (error) {
            console.warn(
              `consistency_task_source_task_backfill_failed id=${record.id} originalTaskId=${String(originalTaskId)} error=${formatError(error)}`,
            );
            return record;
          }
        }),
      );
      res.json({ success: true, items });
    } catch (error) {
      console.error(`consistency_task_table_read_failed error=${formatError(error)}`);
      res.status(500).json({ success: false, message: "Consistency task table is unavailable" });
    }
  };
}

export function createReplaceConsistencyTasksHandler(store: ConsistencyTaskStore) {
  return async (req: Request, res: Response) => {
    const items = readConsistencyTaskRecords(req);
    if (typeof items === "string") {
      res.status(400).json({ success: false, message: items });
      return;
    }

    try {
      if (items.length === 0 && (await store.list()).length > 0) {
        res.status(409).json({
          success: false,
          message: "Refusing to replace existing consistency tasks with an empty collection",
        });
        return;
      }
      res.json({ success: true, items: await store.replace(items) });
    } catch (error) {
      console.error(`consistency_task_table_write_failed error=${formatError(error)}`);
      res.status(500).json({ success: false, message: "Consistency task table is unavailable" });
    }
  };
}

export function createUpsertConsistencyTaskHandler(store: ConsistencyTaskStore) {
  return async (req: Request, res: Response) => {
    const item = readConsistencyTaskRecord(req);
    if (typeof item === "string") {
      res.status(400).json({ success: false, message: item });
      return;
    }

    try {
      res.json({ success: true, item: await store.upsert(item) });
    } catch (error) {
      console.error(`consistency_task_record_write_failed error=${formatError(error)}`);
      res.status(500).json({ success: false, message: "Consistency task table is unavailable" });
    }
  };
}

export function createPatchConsistencyTaskHandler(store: ConsistencyTaskStore) {
  return async (req: Request, res: Response) => {
    const patch = readConsistencyTaskPatch(req);
    if (typeof patch === "string") {
      res.status(400).json({ success: false, message: patch });
      return;
    }

    const { id } = req.params as { id: string };
    try {
      const existing = (await store.list()).find((item) => item.id === id);
      if (!existing) {
        res.status(404).json({ success: false, message: "Consistency task not found" });
        return;
      }
      const item = await store.upsert(mergeConsistencyTaskPatch(existing, patch));
      res.json({ success: true, item });
    } catch (error) {
      console.error(`consistency_task_record_patch_failed error=${formatError(error)}`);
      res.status(500).json({ success: false, message: "Consistency task table is unavailable" });
    }
  };
}

export function createDeleteConsistencyTaskHandler(
  store: ConsistencyTaskStore,
  options: { remoteTaskRegistry?: Pick<RemoteTaskRegistry, "delete" | "get"> } = {},
) {
  return async (req: Request, res: Response) => {
    const { id } = req.params as { id?: string };
    if (!id || id.trim().length === 0) {
      res.status(400).json({ success: false, message: "Invalid consistency task id" });
      return;
    }

    try {
      const record = (await store.list()).find((item) => item.id === id);
      if (!record) {
        res.status(404).json({ success: false, message: "Consistency task not found" });
        return;
      }
      if (options.remoteTaskRegistry) {
        for (const taskId of readConsistencyRunTaskIds(record)) {
          await deleteRemoteTaskWithArtifacts(options.remoteTaskRegistry, taskId);
        }
      }
      const deleted = await store.delete(id);
      if (!deleted) {
        res.status(404).json({ success: false, message: "Consistency task not found" });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      console.error(`consistency_task_record_delete_failed error=${formatError(error)}`);
      res.status(500).json({ success: false, message: "Consistency task table is unavailable" });
    }
  };
}

export function createCorsMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.header("Origin") ?? "*";
    const requestedHeaders = req.header("Access-Control-Request-Headers");

    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin, Access-Control-Request-Headers");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      requestedHeaders && requestedHeaders.length > 0
        ? requestedHeaders
        : "Content-Type, Authorization",
    );
    res.setHeader("Access-Control-Max-Age", "600");

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  };
}

export function createApp(
  deps: AppDeps = {
    acceptRemoteEvaluationTask,
    prepareRemoteEvaluationTask,
    executeAcceptedRemoteEvaluationTask,
  },
) {
  const app = express();
  const config = getConfig();
  const scoreDb = createScoreDatabase(path.join(config.localCaseRoot, "score-index.sqlite3"));
  const registry = createSqliteRemoteTaskRegistry(scoreDb);
  const consistencyTaskStore = createSqliteConsistencyTaskStore(scoreDb);
  const ruleViolationStatsStore = createSqliteRuleViolationStatsStore(scoreDb);
  const agentTraceStore = createAgentTraceSqliteStore(scoreDb);
  const humanReviewEvidenceStore = createHumanReviewEvidenceStore(config.humanReviewEvidenceRoot);
  const remoteTaskSummaryStore: RemoteTaskSummaryStore = {
    updateTaskSummary(input) {
      updateSqliteRemoteTaskSummary(scoreDb, input);
    },
    async updateAgentTrace(input) {
      try {
        const text = await fs.readFile(
          path.join(input.caseDir, "outputs", "agent-trace.json"),
          "utf-8",
        );
        const report = JSON.parse(text) as AgentTraceReport;
        await Promise.all(
          report.runs.map((run) =>
            agentTraceStore.upsertRun({ ...run, taskId: input.taskId }, "outputs/agent-trace.json"),
          ),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(
            `agent_trace_sqlite_update_failed taskId=${String(input.taskId)} error=${formatError(error)}`,
          );
        }
      }
    },
  };
  const remoteTaskQueue = createRemoteTaskExecutionQueue(
    deps,
    registry,
    ruleViolationStatsStore,
    humanReviewEvidenceStore,
    remoteTaskSummaryStore,
  );
  void backfillSqliteIndexes({ localCaseRoot: config.localCaseRoot, db: scoreDb })
    .catch((error) => {
      console.error(`sqlite_index_backfill_failed error=${formatError(error)}`);
    })
    .then(() => remoteTaskQueue.recoverPendingRemoteTasks())
    .catch((error) => {
      console.error(`remote_task_recovery_failed error=${formatError(error)}`);
    });
  app.use(createCorsMiddleware());
  app.use(express.json({ limit: "2mb" }));

  app.get(API_PATHS.health, (_req, res) => {
    res.json({ ok: true });
  });

  app.post(
    API_PATHS.runRemoteTask,
    createRunRemoteTaskHandler(
      deps,
      registry,
      ruleViolationStatsStore,
      humanReviewEvidenceStore,
      remoteTaskQueue,
    ),
  );
  app.get(
    API_PATHS.ruleViolationStats,
    createGetSqliteRuleViolationStatsHandler((query) =>
      buildSqliteRuleViolationStatsResponse(scoreDb, query),
    ),
  );
  app.get(API_PATHS.remoteTaskResult, createGetRemoteTaskResultHandler(registry));
  app.get(API_PATHS.remoteTaskRawResult, createGetRemoteTaskRawResultHandler(registry));
  app.get(API_PATHS.remoteTaskStatuses, createGetRemoteTaskStatusesHandler(registry));
  app.delete(API_PATHS.remoteTasks, createDeleteRemoteTasksHandler(registry));
  app.get(
    API_PATHS.consistencyTasks,
    createGetConsistencyTasksHandler(consistencyTaskStore, { sourceTaskRegistry: registry }),
  );
  app.put(API_PATHS.consistencyTasks, createReplaceConsistencyTasksHandler(consistencyTaskStore));
  app.put(API_PATHS.consistencyTask, createUpsertConsistencyTaskHandler(consistencyTaskStore));
  app.post(API_PATHS.consistencyTask, createPatchConsistencyTaskHandler(consistencyTaskStore));
  app.delete(
    API_PATHS.consistencyTask,
    createDeleteConsistencyTaskHandler(consistencyTaskStore, { remoteTaskRegistry: registry }),
  );
  app.use(
    createDashboardRouter({
      registry,
      ruleViolationStatsStore,
      agentTraceStore,
      humanReviewEvidenceRoot: config.humanReviewEvidenceRoot,
      taskSummaryProvider: async (query) =>
        listSqliteRemoteTaskSummariesForRange(scoreDb, query ?? {}),
      taskPageProvider: async (query) => listSqliteRemoteTaskPage(scoreDb, query),
      dashboardSummaryProvider: async (query) => summarizeSqliteRemoteTasks(scoreDb, query),
      statusCountsProvider: async () => countSqliteRemoteTaskStatuses(scoreDb),
    }),
  );
  app.post(
    API_PATHS.humanReview,
    createSubmitHumanReviewHandler({ registry, store: humanReviewEvidenceStore }),
  );
  app.use("/dashboard", express.static(path.resolve(process.cwd(), "web", "dist")));
  return app;
}

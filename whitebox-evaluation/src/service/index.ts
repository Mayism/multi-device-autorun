import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { getConfig } from "../config.js";
import { ArtifactStore } from "../commons/io/artifactStore.js";
import { CaseLogger } from "../commons/io/caseLogger.js";
import { formatElapsedDuration } from "../commons/utils/duration.js";
import { uploadTaskCallback } from "../commons/io/uploader.js";
import {
  createOpencodeRunnerPool,
  type OpencodeRunnerLease,
  type OpencodeRunnerPool,
} from "../agents/opencode/runnerPool.js";
import { remoteTaskPreparationNode } from "../workflow/nodes/remoteTaskPreparation/index.js";
import { taskUnderstandingNode } from "../workflow/nodes/taskUnderstanding/index.js";
import { buildRunCaseId } from "./runCaseId.js";
import {
  CaseInput,
  CaseRuleDefinition,
  ConstraintSummary,
  RemoteCallbackPayload,
  RemoteEvaluationTask,
  TaskType,
} from "../types.js";
import {
  runPreparedScoreWorkflow,
  type OpencodeRunner,
} from "../workflow/graph/scoreWorkflow.js";
import type { ScoreGraphState } from "../workflow/graph/state.js";

type ServiceOpencodeDeps = {
  opencodeRunner?: OpencodeRunner;
  onCompleted?: (input: {
    acceptedTask: AcceptedRemoteEvaluationTask;
    workflowResult: Record<string, unknown>;
    resultJson: Record<string, unknown>;
  }) => Promise<void>;
  onCompletedCallbackUploaded?: (input: {
    acceptedTask: AcceptedRemoteEvaluationTask;
    workflowResult: Record<string, unknown>;
    resultJson: Record<string, unknown>;
    uploadMessage: string;
  }) => Promise<void>;
};

let sharedServiceOpencodeRunnerPool: OpencodeRunnerPool | undefined;

function resolveServiceOpencodeRunnerPool(): OpencodeRunnerPool {
  sharedServiceOpencodeRunnerPool ??= createOpencodeRunnerPool({
    size: 3,
    basePort: Number(process.env.HMOS_OPENCODE_PORT ?? 4096),
  });
  return sharedServiceOpencodeRunnerPool;
}

export function setServiceOpencodeRunnerPoolForTesting(
  pool: OpencodeRunnerPool | undefined,
): void {
  sharedServiceOpencodeRunnerPool = pool;
}

export async function stopServiceOpencodeRunnerPool(): Promise<void> {
  const pool = sharedServiceOpencodeRunnerPool;
  if (!pool) {
    return;
  }
  sharedServiceOpencodeRunnerPool = undefined;
  await pool.stopAll();
}

function buildRemoteCallbackPayload(input: {
  taskId: number;
  status: RemoteCallbackPayload["status"];
  resultData?: Record<string, unknown>;
  errorMessage?: string;
}): RemoteCallbackPayload {
  const overallConclusion = asRecord(input.resultData?.overall_conclusion);
  const totalScore =
    input.status === "completed" ? Number(overallConclusion.total_score ?? 0) : undefined;
  const maxScore =
    input.status === "completed" ? Number(overallConclusion.max_score ?? 100) : undefined;

  const payload: RemoteCallbackPayload = {
    taskId: input.taskId,
    status: input.status,
  };

  if (input.status === "completed") {
    payload.success = true;
    payload.totalScore = totalScore;
    payload.maxScore = maxScore;
  }
  if (input.resultData) {
    payload.resultData = input.resultData;
  }
  if (input.errorMessage) {
    payload.errorMessage = input.errorMessage;
  }

  return payload;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function buildCompletedRemoteResultData(input: {
  resultJson: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    basic_info: asRecord(input.resultJson.basic_info),
    overall_conclusion: asRecord(input.resultJson.overall_conclusion),
  };
}

async function uploadRemoteTaskCallbackWithLog(input: {
  remoteTask: RemoteEvaluationTask;
  logger: CaseLogger;
  status: RemoteCallbackPayload["status"];
  phase: string;
  resultData?: Record<string, unknown>;
  errorMessage?: string;
}): Promise<string> {
  const payload = buildRemoteCallbackPayload({
    taskId: input.remoteTask.taskId,
    status: input.status,
    resultData: input.resultData,
    errorMessage: input.errorMessage,
  });
  const upload = await uploadTaskCallback(
    input.remoteTask.callback,
    input.remoteTask.token,
    payload,
  );
  await input.logger.info(
    `回调结果 ${formatRemoteTaskLogContext(input.remoteTask)} status=${input.status} phase=${input.phase} uploaded=${String(upload.uploaded)} message=${upload.message}`,
  );
  return upload.message;
}

function readWorkflowStateFromError(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const workflowState = (error as { workflowState?: unknown }).workflowState;
  return typeof workflowState === "object" && workflowState !== null
    ? (workflowState as Record<string, unknown>)
    : undefined;
}

type AcceptedRemoteWorkflowState = {
  caseDir: string;
  caseInput: CaseInput;
  sourceCasePath: string;
  remoteTaskRootDir: string;
  effectivePatchPath: string;
  caseRuleDefinitions: CaseRuleDefinition[];
  taskUnderstanding: ConstraintSummary;
  taskType: TaskType;
  changedFiles: string[];
  changedLineNumbersByFile: Record<string, number[]>;
  changedFileCount: number;
  inputMode: string;
  originalFileCount: number;
  workspaceFileCount: number;
  hasPatch: boolean;
  remoteBuildSuccess: boolean;
};

type InitialAcceptedRemoteWorkflowState = {
  stage: "accepted";
  caseDir: string;
};

type RemoteTaskRecoveryInput = {
  taskId: number;
  caseDir: string;
  remoteTaskFile?: string;
};

export type AcceptedRemoteEvaluationTask = {
  taskId: number;
  caseDir: string;
  message: string;
  remoteTask: RemoteEvaluationTask;
  workflowState: InitialAcceptedRemoteWorkflowState | AcceptedRemoteWorkflowState;
  opencodeRunner?: OpencodeRunner;
  opencodeRunnerLease?: OpencodeRunnerLease;
};

const REMOTE_TASK_ACCEPTED_MESSAGE = "任务接收成功，结果将通过 callback 返回";
export const REMOTE_TASK_PAYLOAD_FILE = "inputs/remote-task.json";

function resolveRemoteTaskPayloadPath(input: RemoteTaskRecoveryInput): string {
  return path.join(input.caseDir, input.remoteTaskFile ?? REMOTE_TASK_PAYLOAD_FILE);
}

async function readPersistedRemoteTask(
  input: RemoteTaskRecoveryInput,
): Promise<RemoteEvaluationTask> {
  const text = await fsp.readFile(resolveRemoteTaskPayloadPath(input), "utf-8");
  const parsed = JSON.parse(text) as RemoteEvaluationTask;
  if (parsed.taskId !== input.taskId) {
    throw new Error(
      `Persisted remote task id mismatch: expected ${String(input.taskId)}, got ${String(parsed.taskId)}`,
    );
  }
  return parsed;
}

function formatRemoteTaskLogContext(remoteTask: RemoteEvaluationTask): string {
  return `taskId=${String(remoteTask.taskId)} testCaseId=${String(remoteTask.testCase.id)}`;
}

function buildRemoteCaseInfoBase(
  remoteTask: RemoteEvaluationTask,
  caseDir: string,
  config: ReturnType<typeof getConfig>,
) {
  return {
    case_id: path.basename(caseDir),
    source_case_path: null,
    task_type: null,
    original_project_path: null,
    generated_project_path: null,
    patch_path: null,
    started_at: new Date().toISOString(),
    rubric_scoring_payload_file: "inputs/rubric-scoring-payload.json",
    rule_agent_bootstrap_payload_file: "inputs/rule-agent-bootstrap-payload.json",
    agent_runtime: "opencode",
    input_mode: "remote_task",
    remote_task_id: remoteTask.taskId,
    remote_test_case_id: remoteTask.testCase.id,
    remote_test_case_name: remoteTask.testCase.name,
    remote_test_case_type: remoteTask.testCase.type,
  };
}

function buildRemoteCaseInfoPayload(
  caseInfoBase: ReturnType<typeof buildRemoteCaseInfoBase>,
  state: Partial<AcceptedRemoteWorkflowState> | Record<string, unknown>,
  statuses?: {
    rubricAgentRunStatus?: string;
    ruleAgentRunStatus?: string;
  },
) {
  const caseInput =
    typeof state.caseInput === "object" && state.caseInput !== null
      ? (state.caseInput as CaseInput)
      : undefined;
  const sourceCasePath = typeof state.sourceCasePath === "string" ? state.sourceCasePath : null;
  const taskType = typeof state.taskType === "string" ? state.taskType : null;

  return {
    ...caseInfoBase,
    source_case_path: sourceCasePath,
    task_type: taskType,
    original_project_path: caseInput?.originalProjectPath ?? null,
    generated_project_path: caseInput?.generatedProjectPath ?? null,
    patch_path: caseInput?.patchPath ?? null,
    rubric_agent_run_status: statuses?.rubricAgentRunStatus ?? "not_enabled",
    rule_agent_run_status: statuses?.ruleAgentRunStatus ?? "not_enabled",
  };
}

function readRemoteTaskRootDirFromError(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const rootDir = (error as { remoteTaskRootDir?: unknown }).remoteTaskRootDir;
  return typeof rootDir === "string" ? rootDir : undefined;
}

function toAcceptedRemoteWorkflowState(
  state: Partial<ScoreGraphState>,
): AcceptedRemoteWorkflowState {
  if (!state.caseDir) {
    throw new Error("Accepted remote task is missing caseDir.");
  }
  if (!state.caseInput) {
    throw new Error("Accepted remote task is missing caseInput.");
  }
  if (!state.sourceCasePath) {
    throw new Error("Accepted remote task is missing sourceCasePath.");
  }
  if (!state.remoteTaskRootDir) {
    throw new Error("Accepted remote task is missing remoteTaskRootDir.");
  }
  if (!state.taskUnderstanding) {
    throw new Error("Accepted remote task is missing taskUnderstanding.");
  }
  if (!state.effectivePatchPath) {
    throw new Error("Accepted remote task is missing effectivePatchPath.");
  }
  if (!state.taskType) {
    throw new Error("Accepted remote task is missing taskType.");
  }
  if (typeof state.originalFileCount !== "number") {
    throw new Error("Accepted remote task is missing originalFileCount.");
  }
  if (typeof state.workspaceFileCount !== "number") {
    throw new Error("Accepted remote task is missing workspaceFileCount.");
  }
  if (typeof state.hasPatch !== "boolean") {
    throw new Error("Accepted remote task is missing hasPatch.");
  }
  if (typeof state.remoteBuildSuccess !== "boolean") {
    throw new Error("Accepted remote task is missing remoteBuildSuccess.");
  }

  return {
    caseDir: state.caseDir,
    caseInput: state.caseInput,
    sourceCasePath: state.sourceCasePath,
    remoteTaskRootDir: state.remoteTaskRootDir,
    effectivePatchPath: state.effectivePatchPath,
    caseRuleDefinitions: state.caseRuleDefinitions ?? [],
    taskUnderstanding: state.taskUnderstanding,
    taskType: state.taskType,
    changedFiles: state.changedFiles ?? state.evidenceSummary?.changedFiles ?? [],
    changedLineNumbersByFile:
      state.changedLineNumbersByFile ?? state.evidenceSummary?.changedLineNumbersByFile ?? {},
    changedFileCount:
      state.changedFileCount ?? state.evidenceSummary?.changedFileCount ?? state.changedFiles?.length ?? 0,
    inputMode: state.inputMode ?? "remote",
    originalFileCount: state.originalFileCount,
    workspaceFileCount: state.workspaceFileCount,
    hasPatch: state.hasPatch,
    remoteBuildSuccess: state.remoteBuildSuccess,
  };
}

export async function acceptRemoteEvaluationTask(
  remoteTask: RemoteEvaluationTask,
): Promise<AcceptedRemoteEvaluationTask> {
  const config = getConfig();
  const artifactStore = new ArtifactStore(config.localCaseRoot);
  const caseDir = await artifactStore.ensureCaseDir(
    buildRunCaseId({
      taskType: "case",
      taskId: remoteTask.taskId,
      uniqueId: randomUUID().replace(/-/g, "").slice(0, 8),
    }),
  );
  const logger = new CaseLogger(artifactStore, caseDir);
  const caseInfoBase = buildRemoteCaseInfoBase(remoteTask, caseDir, config);
  const acceptedState: InitialAcceptedRemoteWorkflowState = {
    stage: "accepted",
    caseDir,
  };

  await logger.info(`启动远端评分流程 ${formatRemoteTaskLogContext(remoteTask)}`);
  await artifactStore.writeJson(
    caseDir,
    "inputs/case-info.json",
    buildRemoteCaseInfoPayload(caseInfoBase, acceptedState),
  );
  await logger.info("输入元数据写入完成");
  await artifactStore.writeJson(caseDir, REMOTE_TASK_PAYLOAD_FILE, remoteTask);
  await logger.info("远端任务原始请求写入完成");
  await logger.info("远端任务预处理开始");

  return {
    taskId: remoteTask.taskId,
    caseDir,
    message: REMOTE_TASK_ACCEPTED_MESSAGE,
    remoteTask,
    workflowState: acceptedState,
  };
}

export async function restoreAcceptedRemoteEvaluationTask(
  input: RemoteTaskRecoveryInput,
): Promise<AcceptedRemoteEvaluationTask> {
  const remoteTask = await readPersistedRemoteTask(input);
  return {
    taskId: input.taskId,
    caseDir: input.caseDir,
    message: REMOTE_TASK_ACCEPTED_MESSAGE,
    remoteTask,
    workflowState: { stage: "accepted", caseDir: input.caseDir },
  };
}

export async function replayCompletedRemoteTaskCallback(
  input: RemoteTaskRecoveryInput,
): Promise<string> {
  const remoteTask = await readPersistedRemoteTask(input);
  const config = getConfig();
  const artifactStore = new ArtifactStore(config.localCaseRoot);
  const logger = new CaseLogger(artifactStore, input.caseDir);
  const resultText = await fsp.readFile(
    path.join(input.caseDir, "outputs", "result.json"),
    "utf-8",
  );
  const resultJson = JSON.parse(resultText) as Record<string, unknown>;
  return await uploadRemoteTaskCallbackWithLog({
    remoteTask,
    logger,
    status: "completed",
    phase: "recovered_completed",
    resultData: buildCompletedRemoteResultData({ resultJson }),
  });
}

async function prepareAcceptedRemoteEvaluationTask(
  acceptedTask: AcceptedRemoteEvaluationTask,
  deps: ServiceOpencodeDeps = {},
): Promise<AcceptedRemoteEvaluationTask> {
  if (!("stage" in acceptedTask.workflowState)) {
    return acceptedTask;
  }

  const config = getConfig();
  const artifactStore = new ArtifactStore(config.localCaseRoot);
  const logger = new CaseLogger(artifactStore, acceptedTask.caseDir);
  const caseInfoBase = buildRemoteCaseInfoBase(
    acceptedTask.remoteTask,
    acceptedTask.caseDir,
    config,
  );
  const preparedState: Partial<ScoreGraphState> = {
    ...acceptedTask.workflowState,
    remoteTask: acceptedTask.remoteTask,
    caseDir: acceptedTask.caseDir,
  };
  let runnerLease: OpencodeRunnerLease | undefined;

  try {
    Object.assign(
      preparedState,
      await remoteTaskPreparationNode(preparedState as ScoreGraphState, { logger }),
    );
    await logger.info("远端任务预处理完成");
    runnerLease =
      !deps.opencodeRunner && !acceptedTask.opencodeRunner && !acceptedTask.opencodeRunnerLease
        ? await resolveServiceOpencodeRunnerPool().acquire()
        : undefined;
    const opencodeRunner =
      deps.opencodeRunner ??
      acceptedTask.opencodeRunner ??
      acceptedTask.opencodeRunnerLease?.runner ??
      runnerLease?.runner;
    if (!opencodeRunner) {
      throw new Error("远端任务 opencode runner 未配置");
    }
    Object.assign(
      preparedState,
      await taskUnderstandingNode(preparedState as ScoreGraphState, {
        opencode: opencodeRunner,
        artifactStore,
        logger,
      }),
    );
    await logger.info("初始任务分析完成");
    await logger.info(`任务理解完成 taskType=${String(preparedState.taskType ?? "")}`);
    await artifactStore.writeJson(
      acceptedTask.caseDir,
      "inputs/case-info.json",
      buildRemoteCaseInfoPayload(caseInfoBase, preparedState),
    );
    await logger.info("任务接收完成，已转入异步执行");

    return {
      ...acceptedTask,
      workflowState: toAcceptedRemoteWorkflowState(preparedState),
      opencodeRunner,
      opencodeRunnerLease: acceptedTask.opencodeRunnerLease ?? runnerLease,
    };
  } catch (error) {
    runnerLease?.release();
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    await logger.error(
      `预处理失败 ${formatRemoteTaskLogContext(acceptedTask.remoteTask)} error=${message}`,
    );
    const remoteTaskRootDir =
      typeof preparedState.remoteTaskRootDir === "string"
        ? preparedState.remoteTaskRootDir
        : readRemoteTaskRootDirFromError(error);
    if (remoteTaskRootDir) {
      await fsp.rm(remoteTaskRootDir, { recursive: true, force: true });
    }
    acceptedTask.opencodeRunnerLease?.release();
    throw error;
  }
}

export async function prepareRemoteEvaluationTask(
  remoteTask: RemoteEvaluationTask,
  deps: ServiceOpencodeDeps = {},
): Promise<AcceptedRemoteEvaluationTask> {
  const acceptedTask = await acceptRemoteEvaluationTask(remoteTask);
  return await prepareAcceptedRemoteEvaluationTask(acceptedTask, deps);
}

export async function executeAcceptedRemoteEvaluationTask(
  acceptedTask: AcceptedRemoteEvaluationTask,
  deps: ServiceOpencodeDeps = {},
): Promise<string> {
  const config = getConfig();
  const artifactStore = new ArtifactStore(config.localCaseRoot);
  const logger = new CaseLogger(artifactStore, acceptedTask.caseDir);
  const caseInfoBase = buildRemoteCaseInfoBase(
    acceptedTask.remoteTask,
    acceptedTask.caseDir,
    config,
  );
  let workflowResult: Record<string, unknown> = { ...acceptedTask.workflowState };
  let preparedTask = acceptedTask;
  const evaluationStartedAt = Date.now();

  try {
    await logger.info(`异步评分执行开始 ${formatRemoteTaskLogContext(acceptedTask.remoteTask)}`);
    await uploadRemoteTaskCallbackWithLog({
      remoteTask: acceptedTask.remoteTask,
      logger,
      status: "pending",
      phase: "execution_accepted",
    });
    await uploadRemoteTaskCallbackWithLog({
      remoteTask: acceptedTask.remoteTask,
      logger,
      status: "running",
      phase: "workflow_started",
    });
    preparedTask = await prepareAcceptedRemoteEvaluationTask(acceptedTask, deps);
    workflowResult = { ...preparedTask.workflowState };
    workflowResult = await runPreparedScoreWorkflow({
      preparedState: preparedTask.workflowState as AcceptedRemoteWorkflowState,
      caseDir: preparedTask.caseDir,
      referenceRoot: config.referenceRoot,
      artifactStore,
      opencodeRunner:
        deps.opencodeRunner ??
        preparedTask.opencodeRunner ??
        preparedTask.opencodeRunnerLease?.runner,
    });
    await artifactStore.writeJson(
      acceptedTask.caseDir,
      "inputs/case-info.json",
      buildRemoteCaseInfoPayload(caseInfoBase, workflowResult, {
        rubricAgentRunStatus:
          typeof workflowResult.rubricAgentRunStatus === "string"
            ? workflowResult.rubricAgentRunStatus
            : "not_enabled",
        ruleAgentRunStatus:
          typeof workflowResult.ruleAgentRunStatus === "string"
            ? workflowResult.ruleAgentRunStatus
            : "not_enabled",
      }),
    );
    await logger.info("工作流执行完成");
    await logger.info("结果已落盘");
    await uploadRemoteTaskCallbackWithLog({
      remoteTask: acceptedTask.remoteTask,
      logger,
      status: "running",
      phase: "result_persisted",
    });

    const resultJson =
      typeof workflowResult.resultJson === "object" && workflowResult.resultJson !== null
        ? (workflowResult.resultJson as Record<string, unknown>)
        : {};

    try {
      await deps.onCompleted?.({
        acceptedTask: preparedTask,
        workflowResult,
        resultJson,
      });
    } catch (error) {
      await logger.warn(
        `完成后处理失败 ${formatRemoteTaskLogContext(acceptedTask.remoteTask)} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const uploadMessage = await uploadRemoteTaskCallbackWithLog({
      remoteTask: acceptedTask.remoteTask,
      logger,
      status: "completed",
      phase: "completed",
      resultData: buildCompletedRemoteResultData({
        resultJson,
      }),
    });
    await logger.info(`本次用例评分耗时=${formatElapsedDuration(Date.now() - evaluationStartedAt)}`);
    if (deps.onCompletedCallbackUploaded) {
      void deps
        .onCompletedCallbackUploaded({
          acceptedTask: preparedTask,
          workflowResult,
          resultJson,
          uploadMessage,
        })
        .catch((error) => {
          void logger.warn(
            `完成回调后处理失败 ${formatRemoteTaskLogContext(acceptedTask.remoteTask)} error=${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
    return uploadMessage;
  } catch (error) {
    workflowResult = readWorkflowStateFromError(error) ?? workflowResult;
    const message = error instanceof Error ? error.message : String(error);
    await logger.error(
      `执行失败 ${formatRemoteTaskLogContext(acceptedTask.remoteTask)} error=${message}`,
    );
    await uploadRemoteTaskCallbackWithLog({
      remoteTask: acceptedTask.remoteTask,
      logger,
      status: "failed",
      phase: "failed",
      errorMessage: message,
    });
    throw error;
  } finally {
    preparedTask.opencodeRunnerLease?.release();
    const remoteTaskRootDir =
      typeof workflowResult.remoteTaskRootDir === "string"
        ? workflowResult.remoteTaskRootDir
        : "remoteTaskRootDir" in preparedTask.workflowState
          ? preparedTask.workflowState.remoteTaskRootDir
          : undefined;
    if (remoteTaskRootDir) {
      await fsp.rm(remoteTaskRootDir, { recursive: true, force: true });
    }
  }
}

export async function runRemoteEvaluationTask(
  remoteTask: RemoteEvaluationTask,
  deps: ServiceOpencodeDeps = {},
): Promise<{ caseDir: string; taskId: number; uploadMessage?: string }> {
  const acceptedTask = await prepareRemoteEvaluationTask(remoteTask, deps);
  const uploadMessage = await executeAcceptedRemoteEvaluationTask(acceptedTask, deps);

  return {
    caseDir: acceptedTask.caseDir,
    taskId: acceptedTask.taskId,
    uploadMessage,
  };
}

import type {
  OpencodeRunRequest,
  OpencodeRunResult,
} from "../../agents/opencode/cliRunner.js";
import type { OpencodeRuntimeConfig } from "../../agents/opencode/config.js";
import type { OpencodeServeManager } from "../../agents/opencode/serveManager.js";
import type { ArtifactStore } from "../../commons/io/artifactStore.js";
import type { RemoteEvaluationTask } from "../../types.js";
import type { ScoreGraphState } from "./state.js";

/**
 * OpenCode runtime 生命周期：
 * - shared: 多次 workflow 复用同一个服务，适合批量评分。
 * - ephemeral: 单次 workflow 独占服务，结束后自动停止，适合隔离调试。
 */
export type OpencodeRuntimeLifecycle = "shared" | "ephemeral";

/** Workflow 节点调用 OpenCode Agent 的统一适配器，便于测试注入与运行时追踪。 */
export type OpencodeRunner = {
  runPrompt(request: OpencodeRunRequest): Promise<OpencodeRunResult>;
};

/** 由本 workflow 创建或复用的 OpenCode 运行时资源。 */
export type OpencodeWorkflowRuntime = {
  runtime: OpencodeRuntimeConfig;
  serveManager: OpencodeServeManager;
};

/** 远端任务入口输入，用于从 remoteTask 开始完整执行评分图。 */
export type RemoteWorkflowInput = WorkflowCommonInput & {
  remoteTask: RemoteEvaluationTask;
};

/** 已完成前置准备的入口输入，用于从 preparedState 续跑评分图。 */
export type PreparedWorkflowInput = WorkflowCommonInput & {
  preparedState: Pick<
    ScoreGraphState,
    | "caseInput"
    | "sourceCasePath"
    | "remoteTaskRootDir"
    | "inputMode"
    | "originalFileCount"
    | "workspaceFileCount"
    | "hasPatch"
    | "caseDir"
    | "effectivePatchPath"
    | "caseRuleDefinitions"
    | "taskUnderstanding"
    | "taskType"
    | "changedFiles"
    | "changedLineNumbersByFile"
    | "changedFileCount"
  > &
    Partial<Pick<ScoreGraphState, "remoteBuildSuccess" | "agentBuildResult">>;
};

/** 两种 workflow 入口共享的基础依赖。 */
export type WorkflowCommonInput = {
  caseDir: string;
  referenceRoot: string;
  artifactStore: ArtifactStore;
  opencodeRuntime?: OpencodeRuntimeConfig;
  opencodeServeManager?: OpencodeServeManager;
  opencodeRuntimeLifecycle?: OpencodeRuntimeLifecycle;
  opencodeRunner?: OpencodeRunner;
};

/** LangGraph compile 后只暴露本模块需要的 stream 能力。 */
export type CompiledScoreGraph = {
  stream(
    initialState: Record<string, unknown>,
    config: { streamMode: string[] },
  ): Promise<AsyncIterable<[string, unknown]>>;
};

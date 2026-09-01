import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { OpencodeRunRequest, OpencodeRunResult } from "../../../agents/opencode/cliRunner.js";
import type { ArtifactStore } from "../../../commons/io/artifactStore.js";

/** taskUnderstanding 节点的可注入依赖，主要用于 OpenCode 调用、产物写入和日志记录。 */
export type TaskUnderstandingDeps = {
  opencode?: {
    runPrompt(request: OpencodeRunRequest): Promise<OpencodeRunResult>;
  };
  artifactStore?: ArtifactStore;
  logger?: {
    info(message: string): Promise<void>;
    warn(message: string): Promise<void>;
  };
};

/** 区分第二参数是节点依赖还是 LangGraph 运行配置。 */
export function isTaskUnderstandingDeps(
  value: TaskUnderstandingDeps | LangGraphRunnableConfig | undefined,
): value is TaskUnderstandingDeps {
  if (!value || typeof value !== "object") {
    return false;
  }
  return "opencode" in value || "artifactStore" in value || "logger" in value;
}

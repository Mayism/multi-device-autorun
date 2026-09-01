import { getWriter, type LangGraphRunnableConfig } from "@langchain/langgraph";
import type { WorkflowNodeId } from "./types.js";

function resolveWriter(config?: LangGraphRunnableConfig): ((chunk: unknown) => void) | undefined {
  try {
    return getWriter(config);
  } catch {
    return undefined;
  }
}

// emitNodeStarted 通过 LangGraph custom stream 发出节点开始事件。
export function emitNodeStarted(nodeId: WorkflowNodeId, config?: LangGraphRunnableConfig): void {
  resolveWriter(config)?.({
    event: "node_started",
    nodeId,
  });
}

// emitNodeFailed 通过 LangGraph custom stream 发出节点失败事件。
export function emitNodeFailed(
  nodeId: WorkflowNodeId,
  error: unknown,
  config?: LangGraphRunnableConfig,
): void {
  resolveWriter(config)?.({
    event: "node_failed",
    nodeId,
    errorMessage: error instanceof Error ? error.message : String(error),
  });
}

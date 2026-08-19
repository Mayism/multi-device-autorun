import { getNodeLabel } from "./nodeLabels.js";
import { summarizeNodeUpdate } from "./nodeSummaries.js";
import type { WorkflowLifecycleEvent, WorkflowNodeId } from "./types.js";

type StreamChunk = [string, unknown];

// interpretStreamChunk 负责把 LangGraph streamMode chunk 转成统一的节点观测事件。
export function interpretStreamChunk(chunk: StreamChunk): WorkflowLifecycleEvent | undefined {
  const [mode, payload] = chunk;

  if (mode === "custom") {
    const event = payload as {
      event: "node_started" | "node_failed";
      nodeId: WorkflowNodeId;
      errorMessage?: string;
    };

    if (event.event === "node_started") {
      return {
        level: "info",
        type: "node_started",
        nodeId: event.nodeId,
        label: getNodeLabel(event.nodeId),
      };
    }

    return {
      level: "error",
      type: "node_failed",
      nodeId: event.nodeId,
      label: getNodeLabel(event.nodeId),
      errorMessage: event.errorMessage,
    };
  }

  if (mode === "updates") {
    const [nodeId, update] = Object.entries(
      payload as Record<string, Record<string, unknown>>,
    )[0] as [WorkflowNodeId, Record<string, unknown>];

    return {
      level: "info",
      type: "node_completed",
      nodeId,
      label: getNodeLabel(nodeId),
      summary: summarizeNodeUpdate(nodeId, update),
    };
  }

  return undefined;
}

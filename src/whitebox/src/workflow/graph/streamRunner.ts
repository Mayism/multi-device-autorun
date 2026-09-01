import type { CaseLogger } from "../../commons/io/caseLogger.js";
import { WorkflowEventLogger } from "../observability/workflowEventLogger.js";
import { interpretStreamChunk } from "../observability/workflowStreamInterpreter.js";
import type { CompiledScoreGraph } from "./types.js";

/**
 * 消费 LangGraph stream：
 * - custom 事件用于节点生命周期日志；
 * - updates 事件逐步合并为 finalState，失败时挂到 Error.workflowState 便于排查。
 */
export async function runCompiledScoreGraph(
  logger: CaseLogger,
  graph: CompiledScoreGraph,
  initialState: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const workflowLogger = new WorkflowEventLogger(logger);
  const finalState: Record<string, unknown> = { ...initialState };
  try {
    const stream = await graph.stream(initialState, {
      streamMode: ["updates", "custom"],
    });

    for await (const chunk of stream) {
      const interpreted = interpretStreamChunk(chunk as [string, unknown]);
      if (interpreted) {
        await workflowLogger.log(interpreted);
      }

      if (Array.isArray(chunk) && chunk[0] === "updates") {
        const payload = chunk[1] as Record<string, Record<string, unknown>>;
        for (const update of Object.values(payload)) {
          Object.assign(finalState, update);
        }
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      Object.assign(error, { workflowState: finalState });
    }
    throw error;
  }

  return finalState;
}

import { pruneCompletedCaseArtifacts } from "../../commons/io/caseArtifactCleanup.js";
import { writeWorkflowAgentTrace, enrichAgentTraceRuns } from "./agentTrace.js";
import { createCompiledScoreGraph } from "./compiledGraph.js";
import { shouldKeepCodeLinterResults } from "./linterCleanup.js";
import { runWithOpencodeRuntimeLifecycle } from "./opencodeRuntime.js";
import { runCompiledScoreGraph } from "./streamRunner.js";
import type { PreparedWorkflowInput, RemoteWorkflowInput } from "./types.js";

export type { OpencodeRunner, OpencodeRuntimeLifecycle } from "./types.js";
export { enrichAgentTraceRuns, shouldKeepCodeLinterResults };

/** 从远端任务输入开始执行完整评分 workflow。 */
export async function runScoreWorkflow(
  input: RemoteWorkflowInput,
): Promise<Record<string, unknown>> {
  const result = await runWithOpencodeRuntimeLifecycle(input, async (preparedInput) => {
    const { logger, graph, traceRecorder } = createCompiledScoreGraph(preparedInput, false);
    const initialState = {
      remoteTask: input.remoteTask,
      caseDir: input.caseDir,
    };

    const workflowResult = await runCompiledScoreGraph(logger, graph as never, initialState);
    await writeWorkflowAgentTrace({
      artifactStore: preparedInput.artifactStore,
      caseDir: preparedInput.caseDir,
      traceRecorder,
      runtime: preparedInput.opencodeRuntime,
      logger,
    });
    return workflowResult;
  });
  await pruneCompletedCaseArtifacts(input.caseDir, {
    keepCodeLinterDiagnostics: shouldKeepCodeLinterResults(result),
  });

  return result;
}

/** 从已准备好的状态续跑评分 workflow，复用前置阶段产物。 */
export async function runPreparedScoreWorkflow(
  input: PreparedWorkflowInput,
): Promise<Record<string, unknown>> {
  const result = await runWithOpencodeRuntimeLifecycle(input, async (preparedInput) => {
    const { logger, graph, traceRecorder } = createCompiledScoreGraph(preparedInput, true);
    const workflowResult = await runCompiledScoreGraph(logger, graph as never, {
      ...input.preparedState,
      caseDir: input.caseDir,
    });
    await writeWorkflowAgentTrace({
      artifactStore: preparedInput.artifactStore,
      caseDir: preparedInput.caseDir,
      traceRecorder,
      runtime: preparedInput.opencodeRuntime,
      logger,
    });
    return workflowResult;
  });
  await pruneCompletedCaseArtifacts(input.caseDir, {
    keepCodeLinterDiagnostics: shouldKeepCodeLinterResults(result),
  });
  return result;
}

import { END, START, StateGraph } from "@langchain/langgraph";
import { runOpencodePrompt, type OpencodeRunRequest } from "../../agents/opencode/cliRunner.js";
import { createManagedOpencodeRunner } from "../../agents/opencode/managedRunner.js";
import { createAgentTraceRecorder } from "../../agents/trace/recorder.js";
import { CaseLogger } from "../../commons/io/caseLogger.js";
import { officialCodeLinterNode } from "../nodes/officialCodeLinter/index.js";
import { opencodeSandboxPreparationNode } from "../nodes/opencodeSandboxPreparation/index.js";
import { persistAndUploadNode } from "../nodes/persistAndUpload/index.js";
import { remoteTaskPreparationNode } from "../nodes/remoteTaskPreparation/index.js";
import { reportGenerationNode } from "../nodes/reportGeneration/index.js";
import { rubricPreparationNode } from "../nodes/rubricPreparation/index.js";
import { rubricScoringAgentNode } from "../nodes/rubricScoringAgent/index.js";
import { ruleAssessmentAgentNode } from "../nodes/ruleAssessmentAgent/index.js";
import { ruleMergeNode } from "../nodes/ruleMerge/index.js";
import { rulePreparationNode } from "../nodes/rulePreparation/index.js";
import { scoreFusionOrchestrationNode } from "../nodes/scoreFusionOrchestration/index.js";
import { taskUnderstandingNode } from "../nodes/taskUnderstanding/index.js";
import { ScoreState, type ScoreGraphState } from "./state.js";
import type { RemoteWorkflowInput, WorkflowCommonInput } from "./types.js";

function readTaskIdFromInput(input: WorkflowCommonInput): number | undefined {
  const remoteTask = "remoteTask" in input ? (input as RemoteWorkflowInput).remoteTask : undefined;
  return typeof remoteTask?.taskId === "number" ? remoteTask.taskId : undefined;
}

function createGraphContext(input: WorkflowCommonInput) {
  const logger = new CaseLogger(input.artifactStore, input.caseDir);
  const runtime = input.opencodeRuntime;
  const traceRecorder = createAgentTraceRecorder({
    taskId: readTaskIdFromInput(input),
    caseDir: input.caseDir,
    runtime: runtime
      ? {
          serverUrl: runtime.serverUrl,
          runtimeDir: runtime.runtimeDir,
        }
      : undefined,
  });
  const baseOpencode =
    input.opencodeRunner ??
    (runtime && input.opencodeServeManager
      ? createManagedOpencodeRunner({ runtime, serveManager: input.opencodeServeManager })
      : runtime
        ? {
            runPrompt: (request: OpencodeRunRequest) => runOpencodePrompt({ runtime, request }),
          }
        : undefined);
  const opencode = baseOpencode
    ? {
        runPrompt: (request: OpencodeRunRequest) =>
          traceRecorder.runPrompt(request, baseOpencode.runPrompt),
      }
    : undefined;
  const opencodeForState = (state: ScoreGraphState) =>
    opencode && state.opencodeSandboxRoot
      ? { sandboxRoot: state.opencodeSandboxRoot, runPrompt: opencode.runPrompt }
      : undefined;

  return { input, logger, traceRecorder, opencode, opencodeForState };
}

function createPreparedGraphNodes(context: GraphContext) {
  const { input, logger, opencodeForState } = context;
  return new StateGraph(ScoreState)
    .addNode("opencodeSandboxPreparationNode", (s) => opencodeSandboxPreparationNode(s))
    .addNode("officialCodeLinterNode", (s) => officialCodeLinterNode(s))
    .addNode("rulePreparationNode", (s) =>
      rulePreparationNode(s, { referenceRoot: input.referenceRoot, logger }),
    )
    .addNode("rubricPreparationNode", (s) =>
      rubricPreparationNode(s, { referenceRoot: input.referenceRoot, logger }),
    )
    .addNode("rubricScoringAgentNode", (s) =>
      rubricScoringAgentNode(s, { opencode: opencodeForState(s), logger }),
    )
    .addNode("ruleAssessmentAgentNode", (s) =>
      ruleAssessmentAgentNode(s, { opencode: opencodeForState(s), logger }),
    )
    .addNode("ruleMergeNode", (s) => ruleMergeNode(s, { logger }))
    .addNode("scoreFusionOrchestrationNode", (s) => scoreFusionOrchestrationNode(s))
    .addNode("reportGenerationNode", (s) =>
      reportGenerationNode(s, { referenceRoot: input.referenceRoot }),
    )
    .addNode("persistAndUploadNode", (s) =>
      persistAndUploadNode(s, {
        artifactStore: input.artifactStore,
      }),
    );
}

function createPreparedGraphEdges(graph: ReturnType<typeof createPreparedGraphNodes>) {
  return graph
    .addEdge(START, "opencodeSandboxPreparationNode")
    .addEdge("opencodeSandboxPreparationNode", "officialCodeLinterNode")
    .addEdge("opencodeSandboxPreparationNode", "rulePreparationNode")
    .addEdge("opencodeSandboxPreparationNode", "rubricPreparationNode")
    .addEdge("rulePreparationNode", "ruleAssessmentAgentNode")
    .addEdge("rubricPreparationNode", "rubricScoringAgentNode")
    .addEdge(["ruleAssessmentAgentNode", "officialCodeLinterNode"], "ruleMergeNode")
    .addEdge(["rubricScoringAgentNode", "ruleMergeNode"], "scoreFusionOrchestrationNode")
    .addEdge("scoreFusionOrchestrationNode", "reportGenerationNode")
    .addEdge("reportGenerationNode", "persistAndUploadNode")
    .addEdge("persistAndUploadNode", END);
}

function createFullGraphNodes(context: GraphContext) {
  const { input, logger, opencode } = context;
  const opencodeForState = context.opencodeForState;
  return new StateGraph(ScoreState)
    .addNode("remoteTaskPreparationNode", (s) => remoteTaskPreparationNode(s, { logger }))
    .addNode("taskUnderstandingNode", (s, nodeConfig) =>
      taskUnderstandingNode(
        s,
        {
          opencode,
          artifactStore: input.artifactStore,
          logger,
        },
        nodeConfig,
      ),
    )
    .addNode("officialCodeLinterNode", (s) => officialCodeLinterNode(s))
    .addNode("rulePreparationNode", (s) =>
      rulePreparationNode(s, { referenceRoot: input.referenceRoot, logger }),
    )
    .addNode("rubricPreparationNode", (s) =>
      rubricPreparationNode(s, { referenceRoot: input.referenceRoot, logger }),
    )
    .addNode("rubricScoringAgentNode", (s) =>
      rubricScoringAgentNode(s, { opencode: opencodeForState(s), logger }),
    )
    .addNode("ruleAssessmentAgentNode", (s) =>
      ruleAssessmentAgentNode(s, { opencode: opencodeForState(s), logger }),
    )
    .addNode("ruleMergeNode", (s) => ruleMergeNode(s, { logger }))
    .addNode("scoreFusionOrchestrationNode", (s) => scoreFusionOrchestrationNode(s))
    .addNode("reportGenerationNode", (s) =>
      reportGenerationNode(s, { referenceRoot: input.referenceRoot }),
    )
    .addNode("persistAndUploadNode", (s) =>
      persistAndUploadNode(s, {
        artifactStore: input.artifactStore,
      }),
    );
}

function createFullGraphEdges(graph: ReturnType<typeof createFullGraphNodes>) {
  return graph
    .addEdge(START, "remoteTaskPreparationNode")
    .addEdge("remoteTaskPreparationNode", "taskUnderstandingNode")
    .addEdge("taskUnderstandingNode", "officialCodeLinterNode")
    .addEdge("taskUnderstandingNode", "rulePreparationNode")
    .addEdge("taskUnderstandingNode", "rubricPreparationNode")
    .addEdge("rulePreparationNode", "ruleAssessmentAgentNode")
    .addEdge("rubricPreparationNode", "rubricScoringAgentNode")
    .addEdge(["ruleAssessmentAgentNode", "officialCodeLinterNode"], "ruleMergeNode")
    .addEdge(["rubricScoringAgentNode", "ruleMergeNode"], "scoreFusionOrchestrationNode")
    .addEdge("scoreFusionOrchestrationNode", "reportGenerationNode")
    .addEdge("reportGenerationNode", "persistAndUploadNode")
    .addEdge("persistAndUploadNode", END);
}

type GraphContext = ReturnType<typeof createGraphContext>;

/**
 * 组装评分 LangGraph。
 *
 * resumeFromPreparedState=false: 从远端任务准备和任务理解开始完整执行；
 * resumeFromPreparedState=true: 跳过已完成的前置准备，从沙箱准备继续执行评分链路。
 */
export function createCompiledScoreGraph(
  input: WorkflowCommonInput,
  resumeFromPreparedState: boolean,
) {
  const context = createGraphContext(input);
  return {
    logger: context.logger,
    traceRecorder: context.traceRecorder,
    graph: resumeFromPreparedState
      ? createPreparedGraphEdges(createPreparedGraphNodes(context)).compile()
      : createFullGraphEdges(createFullGraphNodes(context)).compile(),
  };
}

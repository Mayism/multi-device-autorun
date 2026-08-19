import type { WorkflowNodeId } from "./types.js";

const NODE_LABELS: Record<WorkflowNodeId, string> = {
  remoteTaskPreparationNode: "远端任务预处理",
  taskUnderstandingNode: "任务理解",
  opencodeSandboxPreparationNode: "opencode 沙箱准备",
  rulePreparationNode: "规则准备",
  officialCodeLinterNode: "官方 Code Linter",
  rubricPreparationNode: "评分基线准备",
  rubricScoringAgentNode: "Rubric Agent 评分",
  ruleAssessmentAgentNode: "规则 Agent 判定",
  ruleMergeNode: "规则结果合并",
  scoreFusionOrchestrationNode: "评分融合",
  reportGenerationNode: "报告生成",
  persistAndUploadNode: "结果落盘",
};

export function getNodeLabel(nodeId: WorkflowNodeId): string {
  return NODE_LABELS[nodeId];
}

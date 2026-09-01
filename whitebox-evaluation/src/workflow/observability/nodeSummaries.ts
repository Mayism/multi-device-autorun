import type { WorkflowNodeId, WorkflowNodeUpdate } from "./types.js";

type SummaryBuilder = (update: WorkflowNodeUpdate) => string;

function lengthOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function summarizeRemoteTaskPreparation(update: WorkflowNodeUpdate): string {
  return `mode=${String(update.inputMode ?? update.mode ?? "")} originalFiles=${String(update.originalFileCount ?? 0)} workspaceFiles=${String(update.workspaceFileCount ?? 0)} hasPatch=${String(Boolean(update.hasPatch))}`;
}

function summarizeTaskUnderstanding(update: WorkflowNodeUpdate): string {
  const summary = update.taskUnderstanding as
    | {
        explicitConstraints?: string[];
        contextualConstraints?: string[];
        implicitConstraints?: string[];
        classificationHints?: string[];
      }
    | undefined;
  return `explicit=${lengthOf(summary?.explicitConstraints)} contextual=${lengthOf(summary?.contextualConstraints)} implicit=${lengthOf(summary?.implicitConstraints)} classificationHints=${lengthOf(summary?.classificationHints)}`;
}

function summarizeRulePreparation(update: WorkflowNodeUpdate): string {
  const staticRuleAuditResults =
    (update.staticRuleAuditResults as Array<{ result?: string }> | undefined) ?? [];
  const ruleViolations = (update.ruleViolations as unknown[] | undefined) ?? [];
  const uncertainCount = staticRuleAuditResults.filter(
    (item) => item.result === "未接入判定器",
  ).length;
  return `rules=${staticRuleAuditResults.length} violations=${ruleViolations.length} uncertain=${uncertainCount}`;
}

function summarizeRubricPreparation(update: WorkflowNodeUpdate): string {
  const rubricSnapshot = update.rubricSnapshot as
    | {
        dimension_summaries?: unknown[];
        hard_gates?: unknown[];
        review_rule_summary?: unknown[];
      }
    | undefined;
  return `dimensions=${lengthOf(rubricSnapshot?.dimension_summaries)} hardGates=${lengthOf(rubricSnapshot?.hard_gates)} reviewRules=${lengthOf(rubricSnapshot?.review_rule_summary)}`;
}

function summarizeRuleAssessmentAgent(update: WorkflowNodeUpdate): string {
  const runnerResult = update.ruleAgentRunnerResult as
    | {
        outcome?: string;
        final_answer_raw_text?: string;
      }
    | undefined;
  const outputLength = String(runnerResult?.final_answer_raw_text ?? "").length;
  return `status=${String(update.ruleAgentRunStatus ?? runnerResult?.outcome ?? "")} outputLength=${String(outputLength)}`;
}

function summarizeRuleMerge(update: WorkflowNodeUpdate): string {
  const mergedRuleAuditResults =
    (update.mergedRuleAuditResults as Array<{ result?: string }> | undefined) ?? [];
  const reviewRequired = mergedRuleAuditResults.filter(
    (item) => item.result === "待人工复核",
  ).length;
  return `merged=${mergedRuleAuditResults.length} reviewRequired=${reviewRequired}`;
}

function summarizeScoreFusion(update: WorkflowNodeUpdate): string {
  const score = update.scoreComputation as
    | {
        totalScore?: number;
        hardGateTriggered?: boolean;
        risks?: unknown[];
        humanReviewItems?: unknown[];
      }
    | undefined;
  return `totalScore=${String(score?.totalScore ?? 0)} hardGate=${String(Boolean(score?.hardGateTriggered))} risks=${lengthOf(score?.risks)} reviewItems=${lengthOf(score?.humanReviewItems)}`;
}

const SUMMARY_BUILDERS: Record<WorkflowNodeId, SummaryBuilder> = {
  remoteTaskPreparationNode: summarizeRemoteTaskPreparation,
  taskUnderstandingNode: summarizeTaskUnderstanding,
  opencodeSandboxPreparationNode: (update) =>
    `sandboxReady=${String(Boolean(update.opencodeSandboxRoot))}`,
  rulePreparationNode: summarizeRulePreparation,
  officialCodeLinterNode: (update) =>
    `status=${String(update.officialLinterRunStatus ?? "")} findings=${lengthOf(update.officialLinterFindings)} ruleResults=${lengthOf(update.officialLinterRuleResults)}`,
  rubricPreparationNode: summarizeRubricPreparation,
  rubricScoringAgentNode: (update) => {
    const result = update.rubricScoringResult as { item_scores?: unknown[] } | undefined;
    return `status=${String(update.rubricAgentRunStatus ?? "")} items=${lengthOf(result?.item_scores)}`;
  },
  ruleAssessmentAgentNode: summarizeRuleAssessmentAgent,
  ruleMergeNode: summarizeRuleMerge,
  scoreFusionOrchestrationNode: summarizeScoreFusion,
  reportGenerationNode: (update) => `resultReady=${String(Boolean(update.resultJson))}`,
  persistAndUploadNode: (update) => `outputsWritten=${String(Boolean(update.resultJson))}`,
};

// summarizeNodeUpdate 负责把节点 update 收敛成稳定的摘要字符串。
export function summarizeNodeUpdate(nodeId: WorkflowNodeId, update: WorkflowNodeUpdate): string {
  return SUMMARY_BUILDERS[nodeId]?.(update) ?? "summary=unavailable";
}

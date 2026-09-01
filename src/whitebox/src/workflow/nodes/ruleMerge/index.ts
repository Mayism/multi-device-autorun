import { mergeRuleAuditResults } from "../../../agents/normalization/ruleAssistance.js";
import { emitNodeFailed, emitNodeStarted } from "../../observability/nodeCustomEvents.js";
import { ScoreGraphState } from "../../graph/state.js";
import { normalizeRuleImpacts } from "./tools.js";

type RuleMergeDeps = {
  logger?: { info(message: string): Promise<void> };
};

async function buildDeterministicMergeResult(
  state: ScoreGraphState,
  deps: RuleMergeDeps,
): Promise<Partial<ScoreGraphState>> {
  const deterministicRuleResults = [
    ...(state.deterministicRuleResults ?? []),
    ...(state.officialLinterRuleResults ?? []),
  ];
  await deps.logger?.info("rule agent 判定合并完成 source=deterministic-only");
  return {
    mergedRuleAuditResults: deterministicRuleResults,
    normalizedRuleImpacts: normalizeRuleImpacts(deterministicRuleResults),
    ruleAgentAssessmentResult: undefined,
  };
}

async function buildUnavailableAgentMergeResult(
  state: ScoreGraphState,
  deps: RuleMergeDeps,
): Promise<Partial<ScoreGraphState>> {
  const deterministicRuleResults = [
    ...(state.deterministicRuleResults ?? []),
    ...(state.officialLinterRuleResults ?? []),
  ];
  const mergedRuleAuditResults = [
    ...deterministicRuleResults,
    ...(state.assistedRuleCandidates ?? []).map((candidate) => ({
      rule_id: candidate.rule_id,
      rule_summary: candidate.rule_summary ?? candidate.rule_name,
      rule_source: candidate.rule_source,
      result: "待人工复核" as const,
      conclusion: `Agent 不可用，候选规则 ${candidate.rule_id} 已回退为待人工复核。`,
    })),
  ];
  await deps.logger?.info(`rule agent 判定合并完成 status=${state.ruleAgentRunStatus}`);
  return {
    mergedRuleAuditResults,
    normalizedRuleImpacts: normalizeRuleImpacts(mergedRuleAuditResults),
    ruleAgentAssessmentResult: undefined,
  };
}

async function buildAgentMergeResult(
  state: ScoreGraphState,
  deps: RuleMergeDeps,
): Promise<Partial<ScoreGraphState>> {
  const deterministicRuleResults = [
    ...(state.deterministicRuleResults ?? []),
    ...(state.officialLinterRuleResults ?? []),
  ];
  const finalAnswer = state.ruleAgentRunnerResult?.final_answer;
  const merged = mergeRuleAuditResults({
    deterministicRuleResults,
    assistedRuleCandidates: state.assistedRuleCandidates ?? [],
    agentFinalAnswer: finalAnswer,
  });
  const effectiveAgentRunStatus = finalAnswer
    ? "success"
    : state.ruleAgentRunStatus === "failed"
      ? state.ruleAgentRunStatus
      : merged.ruleAgentRunStatus;
  await deps.logger?.info(`rule agent 判定合并完成 status=${effectiveAgentRunStatus}`);
  return {
    ruleAgentRunStatus: effectiveAgentRunStatus,
    ruleAgentAssessmentResult: merged.ruleAgentAssessmentResult ?? undefined,
    mergedRuleAuditResults: merged.mergedRuleAuditResults,
    normalizedRuleImpacts: normalizeRuleImpacts(merged.mergedRuleAuditResults),
  };
}

/** 合并 deterministic、official linter 与 rule agent 的规则判定结果。 */
export async function ruleMergeNode(
  state: ScoreGraphState,
  deps: RuleMergeDeps,
): Promise<Partial<ScoreGraphState>> {
  emitNodeStarted("ruleMergeNode");
  try {
    if ((state.assistedRuleCandidates?.length ?? 0) === 0) {
      return await buildDeterministicMergeResult(state, deps);
    }
    if (state.ruleAgentRunStatus === "skipped" || state.ruleAgentRunStatus === "not_enabled") {
      return await buildUnavailableAgentMergeResult(state, deps);
    }
    return await buildAgentMergeResult(state, deps);
  } catch (error) {
    emitNodeFailed("ruleMergeNode", error);
    throw error;
  }
}

import { collectEvidence } from "../evidence/collectEvidence.js";
import {
  defaultEnabledRulePackIds,
  getEnabledRulePacks,
  listRegisteredRules,
} from "../registry/rulePackRegistry.js";
import type {
  AssistedRuleCandidate,
  CaseInput,
  CaseRuleDefinition,
  EvidenceSummary,
  RuleAuditResult,
  RuleEvidenceIndex,
  RuleViolation,
  StaticRuleAuditResult,
  TaskType,
} from "../../types.js";
import { mapAssistedRuleCandidate } from "./assistedRuleMapper.js";
import { evaluateRegisteredRule } from "./evaluationDispatcher.js";
import { buildRuleEvidenceIndex, getRuleEvidenceFiles } from "./evidenceIndex.js";

// Rule engine 的输出会被 workflow 直接写盘并送入 scoring engine。
export interface RuleEngineOutput {
  staticRuleAuditResults: StaticRuleAuditResult[];
  deterministicRuleResults: RuleAuditResult[];
  caseRuleResults: RuleAuditResult[];
  assistedRuleCandidates: AssistedRuleCandidate[];
  ruleViolations: RuleViolation[];
  enabledRulePacks: Array<{ pack_id: string; display_name: string; version?: string }>;
  ruleEvidenceIndex: RuleEvidenceIndex;
  evidenceSummary: EvidenceSummary;
}

type DeterministicStaticRuleAuditResult = StaticRuleAuditResult & {
  result: Exclude<StaticRuleAuditResult["result"], "未接入判定器">;
};

function isDeterministicStaticRule(
  rule: StaticRuleAuditResult,
): rule is DeterministicStaticRuleAuditResult {
  return rule.result !== "未接入判定器";
}

export async function runRuleEngine(input: {
  referenceRoot: string;
  caseInput: CaseInput;
  taskType: TaskType;
  runtimeRules?: CaseRuleDefinition[];
  enabledRulePackIds?: string[];
}): Promise<RuleEngineOutput> {
  void input.referenceRoot;
  const evidence = await collectEvidence(input.caseInput, { taskType: input.taskType });
  const enabledRulePacks = input.enabledRulePackIds
    ? getEnabledRulePacks(input.enabledRulePackIds)
    : getEnabledRulePacks([...defaultEnabledRulePackIds]);
  const registeredRules = listRegisteredRules({
    enabledPackIds: enabledRulePacks.map((pack) => pack.packId),
    runtimeRules: input.runtimeRules ?? [],
  });
  const ruleSummaryById = new Map(registeredRules.map((rule) => [rule.rule_id, rule.summary]));
  const registeredRuleById = new Map(registeredRules.map((rule) => [rule.rule_id, rule]));
  const evaluatedRules = registeredRules.map((rule) => evaluateRegisteredRule(rule, evidence));
  const evaluatedRuleById = new Map(evaluatedRules.map((rule) => [rule.rule_id, rule]));
  const caseRuleIds = new Set((input.runtimeRules ?? []).map((rule) => rule.rule_id));

  const ruleViolations: RuleViolation[] = evaluatedRules
    .filter((rule) => rule.result === "不满足")
    .map((rule) => ({
      rule_source: rule.rule_source,
      rule_id: rule.rule_id,
      rule_summary: rule.conclusion,
      affected_items: getRuleEvidenceFiles(rule),
      handling_result: "待人工复核",
      evidence: rule.conclusion,
    }));

  const ruleEvidenceIndex = buildRuleEvidenceIndex(evaluatedRules, evidence);

  const staticRuleAuditResults: StaticRuleAuditResult[] = evaluatedRules.map(
    ({
      matchedFiles: _matchedFiles,
      matchedLocations: _matchedLocations,
      matchedSnippets: _matchedSnippets,
      ...rule
    }) => {
      const normalizedRule = {
        ...rule,
        rule_summary: rule.rule_summary ?? ruleSummaryById.get(rule.rule_id) ?? "",
      };
      if (caseRuleIds.has(rule.rule_id)) {
        return normalizedRule;
      }
      return normalizedRule;
    },
  );
  const deterministicRuleResults: RuleAuditResult[] = staticRuleAuditResults
    .filter(isDeterministicStaticRule)
    .filter((rule) => !caseRuleIds.has(rule.rule_id))
    .map((rule) => ({
      rule_id: rule.rule_id,
      rule_summary: rule.rule_summary,
      rule_source: rule.rule_source,
      result: rule.result,
      conclusion: rule.conclusion,
    }));
  const caseRuleResults: RuleAuditResult[] = [];
  const assistedRuleCandidates: AssistedRuleCandidate[] = staticRuleAuditResults
    .filter((rule) => rule.result === "未接入判定器" || caseRuleIds.has(rule.rule_id))
    .map((rule) =>
      mapAssistedRuleCandidate({
        rule,
        registeredRule: registeredRuleById.get(rule.rule_id),
        evaluatedRule: evaluatedRuleById.get(rule.rule_id),
        ruleEvidenceIndex,
      }),
    );

  return {
    staticRuleAuditResults,
    deterministicRuleResults,
    caseRuleResults,
    assistedRuleCandidates,
    ruleViolations,
    enabledRulePacks: enabledRulePacks.map((pack) => ({
      pack_id: pack.packId,
      display_name: pack.displayName,
      ...(pack.version ? { version: pack.version } : {}),
    })),
    ruleEvidenceIndex,
    evidenceSummary: evidence.summary,
  };
}

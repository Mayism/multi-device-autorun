import type {
  AssistedRuleCandidate,
  AssistedRuleReviewEvidence,
  RuleEvidenceIndex,
  StaticRuleAuditResult,
} from "../../types.js";
import type { RegisteredRule } from "../types/ruleTypes.js";
import type { EvaluatedRule } from "../evaluators/shared.js";

type RuntimeTargetCheck = {
  target: string;
  astSignals: Array<Record<string, string>>;
  llmPrompt: string;
};

type AssistedRuleTargetCheck = NonNullable<AssistedRuleCandidate["target_checks"]>[number];

// 将静态层无法最终判定的规则转换为 Agent 可复核的候选任务。
export function mapAssistedRuleCandidate(input: {
  rule: StaticRuleAuditResult;
  registeredRule: RegisteredRule | undefined;
  evaluatedRule: EvaluatedRule | undefined;
  ruleEvidenceIndex: RuleEvidenceIndex;
}): AssistedRuleCandidate {
  const staticPrecheck = input.evaluatedRule?.preliminaryData?.static_precheck as
    | AssistedRuleCandidate["static_precheck"]
    | undefined;
  const reviewEvidence = readReviewEvidence(input);

  return {
    rule_id: input.rule.rule_id,
    rule_summary: input.rule.rule_summary,
    rule_source: input.rule.rule_source,
    why_uncertain: input.rule.conclusion,
    local_preliminary_signal:
      staticPrecheck?.signal_status ??
      (input.registeredRule?.is_case_rule ? "unknown" : "未接入静态判定器，需要agent辅助判定"),
    evidence_files: input.ruleEvidenceIndex[input.rule.rule_id]?.evidenceFiles ?? [],
    evidence_snippets: input.ruleEvidenceIndex[input.rule.rule_id]?.evidenceSnippets ?? [],
    ...(reviewEvidence ? { review_evidence: reviewEvidence } : {}),
    rule_name: input.registeredRule?.rule_name,
    priority: input.registeredRule?.priority,
    decision_criteria: toOutputDecisionCriteria(input.registeredRule?.decisionCriteria),
    kit: readStringArray(input.registeredRule?.detector.config.kit),
    llm_prompt: readLlmPrompt(input.registeredRule?.detector.config),
    ast_signals: readAstSignals(input.registeredRule?.detector.config.astSignals),
    target_checks: readTargetChecks(input.registeredRule?.detector.config.targetChecks),
    static_precheck: staticPrecheck,
    is_case_rule: input.registeredRule?.is_case_rule,
  };
}

function readReviewEvidence(input: {
  rule: StaticRuleAuditResult;
  evaluatedRule: EvaluatedRule | undefined;
}): AssistedRuleReviewEvidence | undefined {
  const preliminary = input.evaluatedRule?.preliminaryData?.reviewEvidence;
  const first = Array.isArray(preliminary) ? preliminary[0] : undefined;
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    return undefined;
  }
  const record = first as Record<string, unknown>;
  const file = typeof record.file === "string" ? record.file : undefined;
  const subject = typeof record.subject === "string" ? record.subject : undefined;
  const evidence =
    typeof record.evidence === "string"
      ? record.evidence
      : typeof record.source === "string"
        ? record.source
        : undefined;
  const question = typeof record.question === "string" ? record.question : undefined;
  if (!file || !subject || !evidence || !question) {
    return undefined;
  }
  return {
    rule_id: input.rule.rule_id,
    file,
    ...(typeof record.line === "number" ? { line: record.line } : {}),
    subject,
    evidence,
    question,
  };
}

function toOutputDecisionCriteria(
  criteria: RegisteredRule["decisionCriteria"] | undefined,
): AssistedRuleCandidate["decision_criteria"] | undefined {
  if (!criteria) {
    return undefined;
  }
  return {
    ...(criteria.pass === undefined ? {} : { pass: criteria.pass }),
    ...(criteria.fail === undefined ? {} : { fail: criteria.fail }),
    ...(criteria.notApplicable === undefined ? {} : { not_applicable: criteria.notApplicable }),
    ...(criteria.review === undefined ? {} : { review: criteria.review }),
  };
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

function readLlmPrompt(detectorConfig: Record<string, unknown> | undefined): string | undefined {
  if (typeof detectorConfig?.llmPrompt === "string") {
    return detectorConfig.llmPrompt;
  }

  const targetChecks = readTargetChecks(detectorConfig?.targetChecks);
  if (!targetChecks) {
    return undefined;
  }

  const checksWithPrompt = targetChecks.filter((check) => check.llm_prompt.length > 0);
  if (checksWithPrompt.length === 0) {
    return undefined;
  }
  if (checksWithPrompt.length === 1) {
    return checksWithPrompt[0]?.llm_prompt;
  }

  return checksWithPrompt.map((check) => `${check.target}: ${check.llm_prompt}`).join("\n");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((item) => typeof item === "string");
}

function readTargetChecks(value: unknown): AssistedRuleCandidate["target_checks"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const targetChecks = value.flatMap((item): AssistedRuleTargetCheck[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const check = item as Partial<RuntimeTargetCheck>;
    if (typeof check.target !== "string") {
      return [];
    }
    const astSignals = Array.isArray(check.astSignals)
      ? check.astSignals.filter(isStringRecord)
      : [];
    return [
      {
        target: check.target,
        ast_signals: astSignals,
        llm_prompt: typeof check.llmPrompt === "string" ? check.llmPrompt : "",
      },
    ];
  });

  return targetChecks.length > 0 ? targetChecks : undefined;
}

function readAstSignals(value: unknown): Array<Record<string, string>> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const astSignals = value.filter(isStringRecord);
  return astSignals.length > 0 ? astSignals : undefined;
}

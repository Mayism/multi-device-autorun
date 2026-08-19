import type { CaseInput, CaseRuleDefinition } from "../../types.js";
import type { RawConstraint, SupportedRuleSource } from "./types.js";

// 将 case 约束映射为规则引擎统一使用的运行时规则定义。
export function mapConstraintToRule(
  constraint: RawConstraint,
  caseInput: CaseInput,
): CaseRuleDefinition {
  const targetChecks = constraint.rules.map((rule) => ({
    target: rule.target,
    astSignals: normalizeAstSignals(rule.ast),
    llmPrompt: rule.llm ?? "",
  }));
  const targetPatterns = constraint.rules.map((rule) => rule.target);
  const astSignals = targetChecks.flatMap((check) => check.astSignals);
  const llmPrompt = formatCombinedLlmPrompt(targetChecks);

  const detectorConfig: CaseRuleDefinition["detector_config"] = {
    targetPatterns,
    astSignals,
    llmPrompt,
    ...(constraint.kit ? { kit: constraint.kit } : {}),
    ...(targetChecks.length > 1 || constraint.kit ? { targetChecks } : {}),
  };

  return {
    pack_id: `case-${caseInput.caseId}`,
    rule_id: constraint.id,
    rule_name: constraint.name,
    rule_source: mapPriorityToRuleSource(constraint.priority),
    summary: constraint.description?.trim() || constraint.name,
    priority: constraint.priority,
    detector_kind: "case_constraint",
    detector_config: detectorConfig,
    fallback_policy: "agent_assisted",
    is_case_rule: true,
  };
}

function normalizeAstSignals(value: unknown): Array<Record<string, string>> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("ast must be an array");
  }

  return value.map((entry, index) => {
    const signal = expectRecord(entry, `ast[${index}]`);
    return Object.fromEntries(
      Object.entries(signal).map(([key, fieldValue]) => [
        key,
        expectString(fieldValue, `ast[${index}].${key}`),
      ]),
    );
  });
}

function formatCombinedLlmPrompt(
  targetChecks: Array<{ target: string; llmPrompt: string }>,
): string {
  const checksWithPrompt = targetChecks.filter((check) => check.llmPrompt.length > 0);
  if (checksWithPrompt.length === 0) {
    return "";
  }
  if (checksWithPrompt.length === 1) {
    return checksWithPrompt[0]?.llmPrompt ?? "";
  }
  return checksWithPrompt.map((check) => `${check.target}: ${check.llmPrompt}`).join("\n");
}

function mapPriorityToRuleSource(priority: "P0" | "P1"): SupportedRuleSource {
  return priority === "P0" ? "must_rule" : "should_rule";
}

function expectRecord(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, location: string): string {
  if (typeof value !== "string") {
    throw new Error(`${location} must be a string`);
  }
  return value;
}

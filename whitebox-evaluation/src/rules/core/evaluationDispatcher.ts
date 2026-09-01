import type { RegisteredRule } from "../types/ruleTypes.js";
import type { CollectedEvidence } from "../evidence/types.js";
import { runArktsStaticRule } from "../evaluators/arkts/staticEvaluator.js";
import { runArkuiExtraRule } from "../evaluators/arkui/extraEvaluator.js";
import { runArkuiStaticRule } from "../evaluators/arkui/staticEvaluator.js";
import { runCaseConstraintRule } from "../evaluators/case-constraint/evaluator.js";
import { runProjectStructureRule } from "../evaluators/project-structure/evaluator.js";
import type { EvaluatedRule } from "../evaluators/shared.js";
import { runTextPatternRule } from "../evaluators/text-pattern/evaluator.js";

// 规则引擎只在这里感知 detector mode 与 evaluator 的绑定关系。
export function evaluateRegisteredRule(
  rule: RegisteredRule,
  evidence: CollectedEvidence,
): EvaluatedRule {
  if (rule.detector.kind === "static") {
    const evaluators = {
      regex: runTextPatternRule,
      project_structure: runProjectStructureRule,
      arkui_extra: runArkuiExtraRule,
      arkui_static: runArkuiStaticRule,
      case_constraint_precheck: runCaseConstraintRule,
      arkts_static: runArktsStaticRule,
      api_usage: runUnsupportedStaticRule,
    } satisfies Record<
      string,
      (rule: RegisteredRule, evidence: CollectedEvidence) => EvaluatedRule
    >;
    return evaluators[rule.detector.mode](rule, evidence);
  }

  return runUnsupportedStaticRule(rule, evidence);
}

function runUnsupportedStaticRule(
  rule: RegisteredRule,
  _evidence: CollectedEvidence,
): EvaluatedRule {
  return {
    rule_id: rule.rule_id,
    rule_source: rule.rule_source,
    result: "未接入判定器",
    conclusion: `${rule.summary} 当前版本未接入静态判定器，需要 Agent 辅助判定。`,
    matchedFiles: [],
  };
}

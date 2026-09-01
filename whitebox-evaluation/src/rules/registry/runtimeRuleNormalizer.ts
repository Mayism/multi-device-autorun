import type { CaseRuleDefinition } from "../../types.js";
import type { RegisteredRule } from "../types/ruleTypes.js";

// 运行时 case 规则复用统一 RegisteredRule 结构，便于规则引擎统一分发。
export function normalizeRuntimeRule(rule: RegisteredRule | CaseRuleDefinition): RegisteredRule {
  if ("detector" in rule) {
    return rule;
  }

  return {
    pack_id: rule.pack_id,
    rule_id: rule.rule_id,
    rule_source: rule.rule_source,
    summary: rule.summary,
    detector: {
      kind: "static",
      mode: "case_constraint_precheck",
      config: rule.detector_config,
    },
    fallback: {
      policy: rule.fallback_policy,
    },
    rule_name: rule.rule_name,
    priority: rule.priority,
    is_case_rule: rule.is_case_rule,
  };
}

import type { NormalizedRuleImpact, RuleAuditResult } from "../../../types.js";

function normalizeOfficialSeverity(
  severity: RuleAuditResult["official_linter_severity"],
): NormalizedRuleImpact["severity"] {
  if (severity === "error") {
    return "major";
  }
  if (severity === "suggestion") {
    return "info";
  }
  return "minor";
}

function normalizeRuleImpact(rule: RuleAuditResult): NormalizedRuleImpact {
  const isOfficial = rule.rule_id.startsWith("OFFICIAL-LINTER:");
  const severity: NormalizedRuleImpact["severity"] = isOfficial
    ? normalizeOfficialSeverity(rule.official_linter_severity)
    : rule.rule_source === "should_rule"
      ? "minor"
      : "major";
  const ruleSource = isOfficial ? "official_linter" : rule.rule_source;

  if (rule.result !== "不满足") {
    return {
      rule_id: rule.rule_id,
      rule_source: ruleSource,
      result: rule.result,
      severity: rule.result === "待人工复核" ? "review" : "info",
      score_effect: {
        mode: rule.result === "待人工复核" ? "review_only" : "none",
        reason: rule.conclusion,
      },
    };
  }

  if (rule.rule_source === "should_rule" || severity === "minor") {
    return {
      rule_id: rule.rule_id,
      rule_source: ruleSource,
      result: rule.result,
      severity,
      score_effect: {
        mode: "deduct",
        points: 2,
        reason: rule.conclusion,
      },
    };
  }

  return {
    rule_id: rule.rule_id,
    rule_source: ruleSource,
    result: rule.result,
    severity,
    score_effect: {
      mode: "cap",
      score_cap: 85,
      reason: rule.conclusion,
    },
  };
}

/** 将规则判定结果归一化为评分融合节点可直接消费的影响模型。 */
export function normalizeRuleImpacts(rules: RuleAuditResult[]): NormalizedRuleImpact[] {
  return rules.map((rule) => normalizeRuleImpact(rule));
}

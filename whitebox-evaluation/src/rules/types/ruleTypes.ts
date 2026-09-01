export type RuleSource = "must_rule" | "should_rule" | "forbidden_pattern";

export type StaticRuleResult = "满足" | "不满足" | "不涉及" | "未接入判定器";

export interface RuleDecisionCriteria {
  pass?: string[];
  fail?: string[];
  notApplicable?: string[];
  review?: string[];
}

// StaticRuleAuditResult 允许暴露静态层内部状态，供 agent 前置链路消费。
export interface StaticRuleAuditResult {
  rule_id: string;
  rule_summary?: string;
  rule_source: RuleSource;
  result: StaticRuleResult;
  conclusion: string;
}

export type StaticDetectorMode =
  | "regex"
  | "project_structure"
  | "arkui_extra"
  | "arkui_static"
  | "case_constraint_precheck"
  | "arkts_static"
  | "api_usage";

export type RuleDetector =
  | { kind: "static"; mode: StaticDetectorMode; config: Record<string, unknown> }
  | { kind: "agent"; config: Record<string, unknown> }
  | { kind: "external"; provider: "official_code_linter"; config: Record<string, unknown> }
  | { kind: "none"; config: Record<string, unknown> };

export interface RuleFallback {
  policy: "agent_assisted" | "not_applicable";
}

export type RuleMetricGroup =
  | "type_safety"
  | "static_quality"
  | "naming"
  | "complexity"
  | "state_flow"
  | "stability"
  | "security_boundary"
  | "performance"
  | "arkui_organization"
  | "harmony_engineering";

export type RuleImpact = "light" | "medium" | "heavy";

export interface RuleProfile {
  scoring: boolean;
  riskCode?: string;
  suppressRubricRiskCodes?: string[];
  metricGroups: RuleMetricGroup[];
  impact: RuleImpact;
}

// RegisteredRule 描述规则包中的单条规则定义，不直接绑定具体 evaluator 实现。
export interface RegisteredRule {
  pack_id: string;
  rule_id: string;
  rule_source: RuleSource;
  summary: string;
  detector: RuleDetector;
  fallback: RuleFallback;
  profile?: RuleProfile;
  rule_name?: string;
  priority?: "P0" | "P1";
  decisionCriteria?: RuleDecisionCriteria;
  is_case_rule?: boolean;
}

export interface RegisteredRulePack {
  packId: string;
  displayName: string;
  version?: string;
  rules: RegisteredRule[];
}

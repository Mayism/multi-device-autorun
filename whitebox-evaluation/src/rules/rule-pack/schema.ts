import type {
  RuleFallback,
  RuleImpact,
  RuleMetricGroup,
  StaticDetectorMode,
} from "../types/ruleTypes.js";

// 内置规则包按该顺序加载，保证报告和测试中的规则顺序稳定。
export const RULE_PACK_FILE_ORDER = [
  "arkts-language.yaml",
  "arkts-performance.yaml",
  "arkui-extra.yaml",
  "cross-device-adaptation.yaml",
];

export const ROOT_KEYS = [
  "name",
  "version",
  "summary",
  "rule_pack_meta",
  "must_rules",
  "should_rules",
  "forbidden_patterns",
];
export const RULE_PACK_META_KEYS = ["pack_id", "source_name", "source_version"];
export const RULE_KEYS = [
  "id",
  "rule",
  "detector",
  "fallback",
  "profile",
  "rule_name",
  "priority",
  "decisionCriteria",
];
export const DETECTOR_KEYS = ["kind", "mode", "provider", "config"];
export const FALLBACK_KEYS = ["policy"];
export const PROFILE_KEYS = [
  "scoring",
  "riskCode",
  "suppressRubricRiskCodes",
  "metricGroups",
  "impact",
];
export const DECISION_CRITERIA_KEYS = ["pass", "fail", "notApplicable", "review"];

export const ALLOWED_STATIC_MODES: StaticDetectorMode[] = [
  "regex",
  "project_structure",
  "arkui_extra",
  "arkui_static",
  "case_constraint_precheck",
  "arkts_static",
  "api_usage",
];

export const ALLOWED_FALLBACK_POLICIES: RuleFallback["policy"][] = [
  "agent_assisted",
  "not_applicable",
];

export const ALLOWED_METRIC_GROUPS: RuleMetricGroup[] = [
  "type_safety",
  "static_quality",
  "naming",
  "complexity",
  "state_flow",
  "stability",
  "security_boundary",
  "performance",
  "arkui_organization",
  "harmony_engineering",
];

export const ALLOWED_IMPACTS: RuleImpact[] = ["light", "medium", "heavy"];

import type {
  RegisteredRule,
  RegisteredRulePack,
  RuleDecisionCriteria,
  RuleDetector,
  RuleFallback,
  RuleProfile,
  RuleSource,
} from "../types/ruleTypes.js";
import {
  ALLOWED_FALLBACK_POLICIES,
  DECISION_CRITERIA_KEYS,
  DETECTOR_KEYS,
  FALLBACK_KEYS,
  PROFILE_KEYS,
  ROOT_KEYS,
  RULE_KEYS,
  RULE_PACK_META_KEYS,
} from "./schema.js";
import {
  assertSupportedKeys,
  expectBoolean,
  expectImpact,
  expectMetricGroups,
  expectPriority,
  expectRecord,
  expectStaticMode,
  expectString,
  expectStringArray,
} from "./validators.js";

export function parseRulePackDocument(value: unknown, location: string): RegisteredRulePack {
  const root = expectRecord(value, location);
  assertSupportedKeys(root, ROOT_KEYS, location);

  const meta = expectRecord(root.rule_pack_meta, `${location}.rule_pack_meta`);
  assertSupportedKeys(meta, RULE_PACK_META_KEYS, `${location}.rule_pack_meta`);

  const packId = expectString(meta.pack_id, `${location}.rule_pack_meta.pack_id`);
  const name = expectString(root.name, `${location}.name`);

  return {
    packId,
    displayName: name,
    ...(root.version === undefined
      ? {}
      : { version: expectString(root.version, `${location}.version`) }),
    rules: [
      ...parseRuleGroup(root.must_rules, "must_rule", packId, `${location}.must_rules`),
      ...parseRuleGroup(root.should_rules, "should_rule", packId, `${location}.should_rules`),
      ...parseRuleGroup(
        root.forbidden_patterns,
        "forbidden_pattern",
        packId,
        `${location}.forbidden_patterns`,
      ),
    ],
  };
}

function parseRuleGroup(
  value: unknown,
  ruleSource: RuleSource,
  packId: string,
  location: string,
): RegisteredRule[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${location} must be an array`);
  }
  return value.map((rule, index) => parseRule(rule, ruleSource, packId, `${location}[${index}]`));
}

function parseRule(
  value: unknown,
  ruleSource: RuleSource,
  packId: string,
  location: string,
): RegisteredRule {
  const rule = expectRecord(value, location);
  assertSupportedKeys(rule, RULE_KEYS, location);

  const detector = parseDetector(rule.detector, `${location}.detector`);
  const fallback = parseFallback(rule.fallback, `${location}.fallback`);
  const ruleSummary = expectString(rule.rule, `${location}.rule`);
  const profile =
    rule.profile === undefined ? undefined : parseProfile(rule.profile, `${location}.profile`);
  const inferredRuleName =
    rule.rule_name === undefined &&
    detector.kind === "static" &&
    detector.mode === "case_constraint_precheck"
      ? inferRuleName(ruleSummary)
      : undefined;
  const inferredPriority =
    rule.priority === undefined &&
    detector.kind === "static" &&
    detector.mode === "case_constraint_precheck"
      ? inferPriority(ruleSource)
      : undefined;

  if (profile?.scoring === true && (!profile.riskCode || profile.metricGroups.length === 0)) {
    throw new Error(`${location}.profile requires riskCode and metricGroups when scoring is true`);
  }
  if (profile === undefined) {
    throw new Error(`${location}.profile is required`);
  }

  return {
    pack_id: packId,
    rule_id: expectString(rule.id, `${location}.id`),
    rule_source: ruleSource,
    summary: ruleSummary,
    detector,
    fallback,
    ...(profile === undefined ? {} : { profile }),
    ...(rule.rule_name === undefined
      ? inferredRuleName === undefined
        ? {}
        : { rule_name: inferredRuleName }
      : { rule_name: expectString(rule.rule_name, `${location}.rule_name`) }),
    ...(rule.priority === undefined
      ? inferredPriority === undefined
        ? {}
        : { priority: inferredPriority }
      : { priority: expectPriority(rule.priority, `${location}.priority`) }),
    ...(rule.decisionCriteria === undefined
      ? {}
      : {
          decisionCriteria: parseDecisionCriteria(
            rule.decisionCriteria,
            `${location}.decisionCriteria`,
          ),
        }),
  };
}

function inferRuleName(summary: string): string {
  return summary.split("。", 1)[0]?.trim() || summary;
}

function inferPriority(ruleSource: RuleSource): "P0" | "P1" | undefined {
  if (ruleSource === "must_rule") {
    return "P0";
  }
  if (ruleSource === "should_rule") {
    return "P1";
  }
  return undefined;
}

function parseDetector(value: unknown, location: string): RuleDetector {
  const detector = expectRecord(value, location);
  assertSupportedKeys(detector, DETECTOR_KEYS, location);
  const kind = expectString(detector.kind, `${location}.kind`);
  const config = expectRecord(detector.config ?? {}, `${location}.config`);

  if (kind === "static") {
    return {
      kind,
      mode: expectStaticMode(detector.mode, `${location}.mode`),
      config: { ...config },
    };
  }
  if (kind === "agent") {
    return { kind, config: { ...config } };
  }
  if (kind === "external") {
    const provider = expectString(detector.provider, `${location}.provider`);
    if (provider !== "official_code_linter") {
      throw new Error(`${location}.provider must be official_code_linter`);
    }
    return { kind, provider, config: { ...config } };
  }
  if (kind === "none") {
    return { kind, config: { ...config } };
  }
  throw new Error(`${location}.kind must be static, agent, external, or none`);
}

function parseFallback(value: unknown, location: string): RuleFallback {
  const fallback = expectRecord(value, location);
  assertSupportedKeys(fallback, FALLBACK_KEYS, location);
  const policy = expectString(fallback.policy, `${location}.policy`);
  if (!ALLOWED_FALLBACK_POLICIES.includes(policy as RuleFallback["policy"])) {
    throw new Error(`${location}.policy must be agent_assisted or not_applicable`);
  }
  return { policy: policy as RuleFallback["policy"] };
}

function parseProfile(value: unknown, location: string): RuleProfile {
  const profile = expectRecord(value, location);
  assertSupportedKeys(profile, PROFILE_KEYS, location);
  const scoring = expectBoolean(profile.scoring, `${location}.scoring`);

  return {
    scoring,
    ...(profile.riskCode === undefined
      ? {}
      : { riskCode: expectString(profile.riskCode, `${location}.riskCode`) }),
    ...(profile.suppressRubricRiskCodes === undefined
      ? {}
      : {
          suppressRubricRiskCodes: expectStringArray(
            profile.suppressRubricRiskCodes,
            `${location}.suppressRubricRiskCodes`,
          ),
        }),
    metricGroups:
      profile.metricGroups === undefined
        ? []
        : expectMetricGroups(profile.metricGroups, `${location}.metricGroups`),
    impact:
      profile.impact === undefined ? "light" : expectImpact(profile.impact, `${location}.impact`),
  };
}

function parseDecisionCriteria(value: unknown, location: string): RuleDecisionCriteria {
  const record = expectRecord(value, location);
  assertSupportedKeys(record, DECISION_CRITERIA_KEYS, location);

  return {
    ...(record.pass === undefined
      ? {}
      : { pass: expectStringArray(record.pass, `${location}.pass`) }),
    ...(record.fail === undefined
      ? {}
      : { fail: expectStringArray(record.fail, `${location}.fail`) }),
    ...(record.notApplicable === undefined
      ? {}
      : { notApplicable: expectStringArray(record.notApplicable, `${location}.notApplicable`) }),
    ...(record.review === undefined
      ? {}
      : { review: expectStringArray(record.review, `${location}.review`) }),
  };
}

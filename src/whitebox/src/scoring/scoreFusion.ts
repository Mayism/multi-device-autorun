import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { LoadedRubric } from "./rubricLoader.js";
import {
  findRiskTaxonomyEntry,
  normalizeRiskItem,
  resolveRiskTaxonomyPrimaryItem,
} from "./riskTaxonomy.js";
import type {
  RiskTaxonomy,
  RiskTaxonomyEntry,
  RiskTaxonomyPrimaryItem,
} from "./riskTaxonomy.js";
import {
  findOfficialLinterRuleProfile,
  officialLinterRuleProfiles,
  officialLinterSeverityToImpactSeverity,
} from "./officialLinterRuleProfiles.js";
import { getRegisteredRulePacks } from "../rules/registry/rulePackRegistry.js";
import type { RuleMetricGroup, RuleProfile } from "../rules/types/ruleTypes.js";
import type {
  AgentRunStatus,
  CaseRuleDefinition,
  DimensionScore,
  EvidenceSummary,
  HvigorBuildCheckSummary,
  HumanReviewItem,
  LoadedRubricSnapshot,
  RiskItem,
  RuleAuditResult,
  RuleImpactDetail,
  RuleViolation,
  RubricScoringItemScore,
  RubricScoringResult,
  ScoreComputation,
  ScoreFusionDetail,
  SubmetricDetail,
  TaskType,
} from "../types.js";

type FuseRubricScoreWithRulesInput = {
  taskType: TaskType;
  rubric: LoadedRubric;
  rubricSnapshot: LoadedRubricSnapshot;
  rubricScoringResult?: RubricScoringResult;
  rubricAgentRunStatus: AgentRunStatus;
  ruleAuditResults: RuleAuditResult[];
  ruleViolations: RuleViolation[];
  evidenceSummary: EvidenceSummary;
  caseRuleDefinitions?: CaseRuleDefinition[];
  hvigorBuildCheckSummary?: HvigorBuildCheckSummary;
  riskTaxonomy?: RiskTaxonomy;
};

type MetricPenaltyRule = {
  metricNames: string[];
  ratio: number;
  severity: RuleImpactDetail["severity"];
};

type CanonicalIssueSource = "rubric" | "rule" | "build";

type CanonicalIssue = {
  issueId: string;
  canonicalCode: string;
  source: CanonicalIssueSource;
  primaryDimension: string;
  primaryItem: string;
  evidenceAnchor: string;
};

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function makeMetricKey(dimensionName: string, metricName: string): string {
  return `${dimensionName}::${metricName}`;
}

const typeSafetyMetrics = [
  "ArkTS/ArkUI语法与类型安全",
  "ArkTS约束遵循度",
  "ArkTS/ArkUI规范符合度",
];
const staticQualityMetrics = ["静态坏味道控制"];
const namingMetrics = ["命名表达清晰度", "命名与风格一致性"];
const complexityMetrics = ["复杂度控制"];
const stateFlowMetrics = ["状态与数据流组织", "状态接入合理性"];
const stabilityRiskMetrics = ["稳定性风险", "回归风险控制"];
const securityBoundaryMetrics = ["安全与边界意识", "安全/边界意识"];
const performanceRiskMetrics = ["性能风险"];
const arkuiOrganizationMetrics = ["ArkUI组织方式合理性"];
const harmonyEngineeringMetrics = ["HarmonyOS工程实践符合度"];

const metricNamesByRuleGroup: Record<RuleMetricGroup, string[]> = {
  type_safety: typeSafetyMetrics,
  static_quality: staticQualityMetrics,
  naming: namingMetrics,
  complexity: complexityMetrics,
  state_flow: stateFlowMetrics,
  stability: stabilityRiskMetrics,
  security_boundary: securityBoundaryMetrics,
  performance: performanceRiskMetrics,
  arkui_organization: arkuiOrganizationMetrics,
  harmony_engineering: harmonyEngineeringMetrics,
};

const ruleProfileById = new Map(
  getRegisteredRulePacks()
    .flatMap((pack) => pack.rules)
    .flatMap((rule) =>
      rule.profile ? [[rule.rule_id, rule.profile] as const] : [],
    ),
);

function normalizeEvidenceAnchor(value: string | undefined): string {
  const source = value ?? "";
  const pathMatch = source.match(
    /(?:generated\/|workspace\/)?([A-Za-z0-9_.@/-]+\.(?:ets|ts|json|yaml|yml|c|cpp|h|hpp|xml|txt))/,
  );
  if (pathMatch?.[1]) {
    return pathMatch[1].replace(/^generated\//, "").replace(/^workspace\//, "");
  }
  return source
    .trim()
    .replace(/:\d+:\d+/g, "")
    .replace(/:\d+/g, "")
    .slice(0, 160);
}

function makeCanonicalIssueId(input: {
  canonicalCode: string;
  taskType: TaskType;
  primaryItem: RiskTaxonomyPrimaryItem;
  evidenceAnchor: string;
}): string {
  return [
    input.canonicalCode,
    input.taskType,
    input.primaryItem.dimension,
    input.primaryItem.item,
    input.evidenceAnchor,
  ].join(":");
}

function buildRubricCanonicalIssue(input: {
  risk: RiskItem;
  taxonomy: RiskTaxonomy | undefined;
  taskType: TaskType;
}): CanonicalIssue | undefined {
  if (!input.taxonomy) {
    return undefined;
  }
  const entry = findRiskTaxonomyEntry(input.taxonomy, input.risk.risk_code);
  if (!entry) {
    return undefined;
  }
  const primaryItem = resolveRiskTaxonomyPrimaryItem(entry, input.taskType);
  if (!primaryItem) {
    return undefined;
  }
  const evidenceAnchor = normalizeEvidenceAnchor(
    input.risk.evidence || input.risk.description,
  );
  if (!evidenceAnchor) {
    return undefined;
  }
  return {
    issueId: makeCanonicalIssueId({
      canonicalCode: entry.code,
      taskType: input.taskType,
      primaryItem,
      evidenceAnchor,
    }),
    canonicalCode: entry.code,
    source: "rubric",
    primaryDimension: primaryItem.dimension,
    primaryItem: primaryItem.item,
    evidenceAnchor,
  };
}

function ruleCanonicalTaxonomyEntry(
  rule: RuleAuditResult,
  taxonomy: RiskTaxonomy | undefined,
): RiskTaxonomyEntry | undefined {
  if (!taxonomy) {
    return undefined;
  }
  const profile = ruleProfileById.get(rule.rule_id);
  if (profile?.riskCode) {
    return findRiskTaxonomyEntry(taxonomy, profile.riskCode);
  }
  const languageRulePrefixes = ["ARKTS-"];
  if (languageRulePrefixes.some((prefix) => rule.rule_id.startsWith(prefix))) {
    return findRiskTaxonomyEntry(taxonomy, "LANGUAGE_CONSTRAINT_VIOLATION");
  }
  return undefined;
}

function buildRuleCanonicalIssue(input: {
  rule: RuleAuditResult;
  taxonomy: RiskTaxonomy | undefined;
  taskType: TaskType;
}): CanonicalIssue | undefined {
  const entry = ruleCanonicalTaxonomyEntry(input.rule, input.taxonomy);
  if (!entry) {
    return undefined;
  }
  const primaryItem = resolveRiskTaxonomyPrimaryItem(entry, input.taskType);
  if (!primaryItem) {
    return undefined;
  }
  const evidenceAnchor = normalizeEvidenceAnchor(input.rule.conclusion);
  if (!evidenceAnchor) {
    return undefined;
  }
  return {
    issueId: makeCanonicalIssueId({
      canonicalCode: entry.code,
      taskType: input.taskType,
      primaryItem,
      evidenceAnchor,
    }),
    canonicalCode: entry.code,
    source: "rule",
    primaryDimension: primaryItem.dimension,
    primaryItem: primaryItem.item,
    evidenceAnchor,
  };
}

function makePenaltyRule(input: {
  metricNames: string[];
  ratio: number;
  severity?: RuleImpactDetail["severity"];
}): MetricPenaltyRule[] {
  return [
    {
      metricNames: input.metricNames,
      ratio: input.ratio,
      severity: input.severity ?? "medium",
    },
  ];
}

function ratioFromRuleImpact(impact: RuleProfile["impact"]): number {
  if (impact === "heavy") {
    return 0.5;
  }
  if (impact === "medium") {
    return 0.35;
  }
  return 0.15;
}

function makeProfilePenaltyRule(profile: RuleProfile): MetricPenaltyRule[] {
  if (!profile.scoring) {
    return [];
  }
  return makePenaltyRule({
    metricNames: Array.from(
      new Set(
        profile.metricGroups.flatMap(
          (group) => metricNamesByRuleGroup[group] ?? [],
        ),
      ),
    ),
    ratio: ratioFromRuleImpact(profile.impact),
    severity: profile.impact,
  });
}

function findPenaltyRules(rule: RuleAuditResult): MetricPenaltyRule[] {
  if (rule.rule_id.startsWith("OFFICIAL-LINTER:")) {
    const officialProfile = findOfficialLinterRuleProfile(rule.rule_id);
    if (!officialProfile) {
      return [];
    }
    const severity =
      officialLinterSeverityToImpactSeverity(rule.official_linter_severity) ??
      officialProfile.severity;
    return makePenaltyRule({
      metricNames: officialProfile.metricNames,
      ratio: officialProfile.ratio,
      severity,
    });
  }

  const profile = ruleProfileById.get(rule.rule_id);
  if (profile) {
    return makeProfilePenaltyRule(profile);
  }

  if (rule.rule_id === "ARKUI-MUST-001") {
    return makePenaltyRule({
      metricNames: harmonyEngineeringMetrics,
      ratio: 0.35,
      severity: "medium",
    });
  }

  if (rule.rule_id === "ARKUI-FORBID-001") {
    return makePenaltyRule({
      metricNames: [...arkuiOrganizationMetrics, ...harmonyEngineeringMetrics],
      ratio: 0.35,
      severity: "medium",
    });
  }

  const typeRuleIds = new Set([
    "ARKTS-FORBID-001",
    "ARKTS-FORBID-002",
    "ARKTS-FORBID-003",
    "ARKTS-MUST-001",
    "ARKTS-FORBID-005",
    "ARKTS-FORBID-006",
    "ARKTS-FORBID-007",
    "ARKTS-FORBID-008",
    "ARKTS-FORBID-009",
    "ARKTS-FORBID-010",
    "ARKTS-MUST-003",
    "ARKTS-MUST-004",
    "ARKTS-FORBID-013",
    "ARKTS-MUST-005",
    "ARKTS-MUST-006",
    "ARKTS-MUST-007",
    "ARKTS-FORBID-016",
    "ARKTS-FORBID-018",
    "ARKTS-MUST-009",
    "ARKTS-SHOULD-002",
    "ARKTS-SHOULD-003",
    "ARKTS-SHOULD-010",
    "ARKTS-FORBID-001",
    "ARKTS-FORBID-003",
    "ARKTS-FORBID-004",
    "ARKTS-FORBID-006",
  ]);
  const namingRuleIds = new Set([
    "ARKTS-SHOULD-004",
    "ARKTS-SHOULD-005",
    "ARKTS-SHOULD-006",
    "ARKTS-SHOULD-007",
    "ARKTS-SHOULD-008",
  ]);
  const styleRuleIds = new Set([
    "ARKTS-FORBID-004",
    "ARKTS-MUST-008",
    "ARKTS-SHOULD-009",
    "ARKTS-SHOULD-011",
  ]);
  const controlFlowRuleIds = new Set([
    "ARKTS-FORBID-014",
    "ARKTS-FORBID-015",
    "ARKTS-MUST-010",
    "ARKTS-FORBID-005",
    "ARKTS-FORBID-021",
    "ARKTS-FORBID-024",
    "ARKTS-FORBID-025",
  ]);
  const runtimeRiskRuleIds = new Set([
    "ARKTS-FORBID-011",
    "ARKTS-FORBID-012",
    "ARKTS-FORBID-017",
    "ARKTS-FORBID-019",
    "ARKTS-FORBID-020",
    "ARKTS-FORBID-007",
    "ARKTS-FORBID-022",
    "ARKTS-FORBID-023",
    "ARKTS-PERF-FORBID-001",
  ]);

  if (typeRuleIds.has(rule.rule_id)) {
    return makePenaltyRule({
      metricNames:
        rule.rule_source === "forbidden_pattern"
          ? [
              ...typeSafetyMetrics,
              ...stabilityRiskMetrics,
              ...securityBoundaryMetrics,
            ]
          : typeSafetyMetrics,
      ratio: rule.rule_source === "must_rule" ? 0.35 : 0.15,
      severity: rule.rule_source === "must_rule" ? "medium" : "light",
    });
  }
  if (namingRuleIds.has(rule.rule_id)) {
    return makePenaltyRule({
      metricNames: namingMetrics,
      ratio: 0.15,
      severity: "light",
    });
  }
  if (styleRuleIds.has(rule.rule_id)) {
    return makePenaltyRule({
      metricNames: staticQualityMetrics,
      ratio: rule.rule_source === "must_rule" ? 0.25 : 0.15,
      severity: rule.rule_source === "must_rule" ? "medium" : "light",
    });
  }
  if (controlFlowRuleIds.has(rule.rule_id)) {
    return makePenaltyRule({
      metricNames: [
        ...complexityMetrics,
        ...staticQualityMetrics,
        ...stabilityRiskMetrics,
      ],
      ratio: rule.rule_source === "forbidden_pattern" ? 0.5 : 0.25,
      severity: rule.rule_source === "forbidden_pattern" ? "heavy" : "medium",
    });
  }
  if (rule.rule_id === "ARKTS-PERF-FORBID-001") {
    return makePenaltyRule({
      metricNames: [...performanceRiskMetrics, ...typeSafetyMetrics],
      ratio: 0.5,
      severity: "heavy",
    });
  }
  if (runtimeRiskRuleIds.has(rule.rule_id)) {
    return makePenaltyRule({
      metricNames: [
        ...stabilityRiskMetrics,
        ...securityBoundaryMetrics,
        ...typeSafetyMetrics,
      ],
      ratio: rule.rule_source === "forbidden_pattern" ? 0.5 : 0.35,
      severity: rule.rule_source === "forbidden_pattern" ? "heavy" : "medium",
    });
  }
  if (rule.rule_id === "ARKTS-SHOULD-001") {
    return makePenaltyRule({
      metricNames: [...stateFlowMetrics, ...stabilityRiskMetrics],
      ratio: 0.15,
      severity: "light",
    });
  }

  if (rule.rule_source === "must_rule") {
    return makePenaltyRule({
      metricNames: typeSafetyMetrics,
      ratio: 0.35,
      severity: "medium",
    });
  }
  if (rule.rule_source === "forbidden_pattern") {
    return makePenaltyRule({
      metricNames: [...stabilityRiskMetrics, ...securityBoundaryMetrics],
      ratio: 0.5,
      severity: "heavy",
    });
  }
  return [];
}

function riskLevelFromRuleImpact(
  rule: RuleAuditResult,
  penaltyRules: MetricPenaltyRule[],
): string {
  if (penaltyRules.some((penalty) => penalty.severity === "heavy")) {
    return "high";
  }
  if (penaltyRules.some((penalty) => penalty.severity === "medium")) {
    return "medium";
  }
  if (penaltyRules.some((penalty) => penalty.severity === "light")) {
    return "low";
  }
  return rule.rule_source === "forbidden_pattern" ? "high" : "medium";
}

function buildCriteriaByMetric(
  rubricSnapshot: LoadedRubricSnapshot,
): Map<string, string> {
  return new Map(
    rubricSnapshot.dimension_summaries.flatMap((dimension) =>
      dimension.item_summaries.map((item) => [
        makeMetricKey(dimension.name, item.name),
        item.scoring_bands
          .map((band) => `${band.score}分：${band.criteria}`)
          .join(" / "),
      ]),
    ),
  );
}

function buildScoringBandsByMetric(
  rubricSnapshot: LoadedRubricSnapshot,
): Map<string, Array<{ score: number }>> {
  return new Map(
    rubricSnapshot.dimension_summaries.flatMap((dimension) =>
      dimension.item_summaries.map((item) => [
        makeMetricKey(dimension.name, item.name),
        item.scoring_bands.map((band) => ({ score: band.score })),
      ]),
    ),
  );
}

function snapScoreToDeclaredBand(
  score: number,
  scoringBands: Array<{ score: number }>,
): number {
  if (scoringBands.length === 0) {
    return roundScore(score);
  }

  return scoringBands.reduce((bestScore, band) => {
    const bestDistance = Math.abs(bestScore - score);
    const currentDistance = Math.abs(band.score - score);
    if (currentDistance < bestDistance) {
      return band.score;
    }
    if (currentDistance === bestDistance) {
      return Math.min(bestScore, band.score);
    }
    return bestScore;
  }, scoringBands[0].score);
}

function buildFallbackRubricItems(
  rubric: LoadedRubric,
): RubricScoringItemScore[] {
  return rubric.dimensions.flatMap((dimension) =>
    dimension.items.map((item) => {
      const bestBand = item.scoringBands[0];
      return {
        dimension_name: dimension.name,
        item_name: item.name,
        score: bestBand?.score ?? item.weight,
        max_score: item.weight,
        matched_band_score: bestBand?.score ?? item.weight,
        rationale:
          "rubric agent 未产出可信扣分依据，暂按满分保留，待人工复核。",
        evidence_used: [],
        confidence: "low",
        review_required: true,
        deduction_trace: undefined,
      };
    }),
  );
}

function selectBaseItems(
  input: FuseRubricScoreWithRulesInput,
): RubricScoringItemScore[] {
  if (input.rubricAgentRunStatus === "success" && input.rubricScoringResult) {
    return input.rubricScoringResult.item_scores;
  }
  return buildFallbackRubricItems(input.rubric);
}

function selectTriggeredGateIds(
  input: FuseRubricScoreWithRulesInput,
): Array<"G1" | "G2" | "G3" | "G4"> {
  const violatedRules = input.ruleAuditResults.filter(
    (rule) => rule.result === "不满足",
  );
  const mustViolations = violatedRules.filter(
    (rule) => rule.rule_source === "must_rule",
  );
  const forbiddenViolations = violatedRules.filter(
    (rule) => rule.rule_source === "forbidden_pattern",
  );
  const caseMustRuleIds = new Set(
    (input.caseRuleDefinitions ?? [])
      .filter((rule) => rule.priority === "P0")
      .map((rule) => rule.rule_id),
  );
  const triggered = new Set<"G1" | "G2" | "G3" | "G4">();

  if (violatedRules.some((rule) => caseMustRuleIds.has(rule.rule_id))) {
    triggered.add("G1");
  }
  if (mustViolations.length >= 2) {
    triggered.add("G1");
  }
  if (
    mustViolations.some((rule) =>
      ["ARKTS-FORBID-003", "ARKTS-FORBID-004", "ARKTS-FORBID-005"].includes(
        rule.rule_id,
      ),
    )
  ) {
    triggered.add("G2");
  }
  if (forbiddenViolations.length > 0) {
    triggered.add("G3");
  }
  if (
    input.taskType === "bug_fix" &&
    (input.evidenceSummary.changedFileCount > 8 ||
      input.evidenceSummary.changedFiles.length > 8)
  ) {
    triggered.add("G4");
  }

  return Array.from(triggered);
}

function selectRuleTriggeredGateIds(
  input: FuseRubricScoreWithRulesInput,
  rule: RuleAuditResult,
): Array<"G1" | "G2" | "G3" | "G4"> {
  const violatedRules = input.ruleAuditResults.filter(
    (item) => item.result === "不满足",
  );
  const mustViolations = violatedRules.filter(
    (item) => item.rule_source === "must_rule",
  );
  const caseMustRuleIds = new Set(
    (input.caseRuleDefinitions ?? [])
      .filter((item) => item.priority === "P0")
      .map((item) => item.rule_id),
  );
  const gateIds = new Set<"G1" | "G2" | "G3" | "G4">();

  if (caseMustRuleIds.has(rule.rule_id)) {
    gateIds.add("G1");
  }
  if (rule.rule_source === "must_rule" && mustViolations.length >= 2) {
    gateIds.add("G1");
  }
  if (
    rule.rule_source === "must_rule" &&
    ["ARKTS-FORBID-003", "ARKTS-FORBID-004", "ARKTS-FORBID-005"].includes(
      rule.rule_id,
    )
  ) {
    gateIds.add("G2");
  }
  if (rule.rule_source === "forbidden_pattern") {
    gateIds.add("G3");
  }

  return Array.from(gateIds);
}

function buildGateCaps(
  input: FuseRubricScoreWithRulesInput,
  gateIds: string[],
): Record<string, number> {
  return Object.fromEntries(
    gateIds.flatMap((gateId) => {
      const scoreCap = input.rubric.hardGates.find(
        (gate) => gate.id === gateId,
      )?.scoreCap;
      return typeof scoreCap === "number" ? [[gateId, scoreCap] as const] : [];
    }),
  );
}

function formatHardGateDescription(
  input: FuseRubricScoreWithRulesInput,
  gateId: string,
): string {
  const gate = input.rubric.hardGates.find((item) => item.id === gateId);
  const signals = gate?.triggerSignals ?? [];
  if (gateId === "G1" && signals.length >= 4) {
    return `${signals[0]}、${signals[1].replace(/^大量/, "")}、${signals[2].replace(/明显$/, "")}或${signals[3]}。`;
  }
  return signals.length > 0
    ? `${signals.join("；")}。`
    : (gate?.name ?? gateId);
}

function buildHardGateTriggerDetail(
  input: FuseRubricScoreWithRulesInput,
  gateId: "G1" | "G2" | "G3" | "G4" | "BUILD-CHECK",
): Record<string, unknown> | undefined {
  if (gateId === "BUILD-CHECK") {
    const scoreCap = input.hvigorBuildCheckSummary?.scoreCap ?? 59;
    return {
      id: "BUILD-CHECK",
      name: "工程编译校验未通过",
      score_cap: scoreCap,
      description: "工程构建或编译校验失败。",
      trigger_reason: "构建校验失败触发硬门槛",
      trigger_policy: {
        type: "build_check_status",
        status: input.hvigorBuildCheckSummary?.status ?? "failed",
      },
      triggered_rule_ids: [],
    };
  }

  const gate = input.rubric.hardGates.find((item) => item.id === gateId);
  if (!gate) {
    return undefined;
  }
  const violatedRules = input.ruleAuditResults.filter(
    (rule) => rule.result === "不满足",
  );
  const mustViolations = violatedRules.filter(
    (rule) => rule.rule_source === "must_rule",
  );
  const forbiddenViolations = violatedRules.filter(
    (rule) => rule.rule_source === "forbidden_pattern",
  );
  const caseMustRuleIds = new Set(
    (input.caseRuleDefinitions ?? [])
      .filter((rule) => rule.priority === "P0")
      .map((rule) => rule.rule_id),
  );
  const caseP0Violations = violatedRules.filter((rule) =>
    caseMustRuleIds.has(rule.rule_id),
  );

  let triggerReason = "硬门槛触发条件成立";
  let triggerPolicy: Record<string, unknown> = { type: "hard_gate_triggered" };
  let triggeredRuleIds: string[] = [];

  if (gateId === "G1" && caseP0Violations.length > 0) {
    triggerReason = "P0 用例约束不满足，触发硬门槛阈值";
    triggerPolicy = {
      type: "case_p0_violation",
      threshold: 1,
      actual: caseP0Violations.length,
    };
    triggeredRuleIds = caseP0Violations.map((rule) => rule.rule_id);
  } else if (gateId === "G1") {
    triggerReason = "must_rule 不满足数量达到硬门槛阈值";
    triggerPolicy = {
      type: "must_violation_count",
      threshold: 2,
      actual: mustViolations.length,
    };
    triggeredRuleIds = mustViolations.map((rule) => rule.rule_id);
  } else if (gateId === "G2") {
    const specificRules = mustViolations.filter((rule) =>
      ["ARKTS-FORBID-003", "ARKTS-FORBID-004", "ARKTS-FORBID-005"].includes(
        rule.rule_id,
      ),
    );
    triggerReason = "关键 ArkTS 规范规则不满足";
    triggerPolicy = {
      type: "specific_must_rule_violation",
      threshold: 1,
      actual: specificRules.length,
    };
    triggeredRuleIds = specificRules.map((rule) => rule.rule_id);
  } else if (gateId === "G3") {
    triggerReason = "forbidden_pattern 不满足数量达到硬门槛阈值";
    triggerPolicy = {
      type: "forbidden_violation_count",
      threshold: 1,
      actual: forbiddenViolations.length,
    };
    triggeredRuleIds = forbiddenViolations.map((rule) => rule.rule_id);
  } else if (gateId === "G4") {
    const actual = Math.max(
      input.evidenceSummary.changedFileCount,
      input.evidenceSummary.changedFiles.length,
    );
    triggerReason = "bug_fix 改动文件数量超过硬门槛阈值";
    triggerPolicy = {
      type: "changed_file_count",
      threshold: 8,
      actual,
    };
  }

  return {
    id: gate.id,
    name: gate.name ?? gate.id,
    score_cap: gate.scoreCap,
    description: formatHardGateDescription(input, gate.id),
    trigger_reason: triggerReason,
    trigger_policy: triggerPolicy,
    triggered_rule_ids: triggeredRuleIds,
  };
}

function buildTriggeredHardGateDetails(
  input: FuseRubricScoreWithRulesInput,
  gateIds: Array<"G1" | "G2" | "G3" | "G4">,
  hvigorHardGateTriggered: boolean,
): Array<Record<string, unknown>> {
  return [
    ...gateIds.flatMap((gateId) => {
      const detail = buildHardGateTriggerDetail(input, gateId);
      return detail ? [detail] : [];
    }),
    ...(hvigorHardGateTriggered
      ? [buildHardGateTriggerDetail(input, "BUILD-CHECK")].filter(
          (detail): detail is Record<string, unknown> => Boolean(detail),
        )
      : []),
  ];
}

function selectUncertainHardGateCandidates(
  input: FuseRubricScoreWithRulesInput,
): Array<{
  gateIds: Array<"G1" | "G2" | "G3" | "G4">;
  rule: RuleAuditResult;
}> {
  return input.ruleAuditResults.flatMap((rule) => {
    if (rule.result !== "待人工复核") {
      return [];
    }
    const gateIds = selectRuleTriggeredGateIds(input, rule);
    return gateIds.length > 0 ? [{ gateIds, rule }] : [];
  });
}

function selectTriggeredHardGateCandidates(
  input: FuseRubricScoreWithRulesInput,
): Array<{
  gateIds: Array<"G1" | "G2" | "G3" | "G4">;
  rule: RuleAuditResult;
}> {
  return input.ruleAuditResults.flatMap((rule) => {
    if (rule.result !== "不满足") {
      return [];
    }
    const gateIds = selectRuleTriggeredGateIds(input, rule);
    return gateIds.length > 0 ? [{ gateIds, rule }] : [];
  });
}

function formatHardGateRule(
  input: FuseRubricScoreWithRulesInput,
  gateId: string,
): string {
  const gate = input.rubric.hardGates.find((item) => item.id === gateId);
  if (!gate) {
    return gateId;
  }
  const title = [gate.id, gate.name].filter(Boolean).join(" ");
  const signals = gate.triggerSignals?.length
    ? `：${gate.triggerSignals.join("；")}`
    : "";
  return `${title}（总分上限 ${gate.scoreCap}）${signals}`;
}

function buildHardGateSuggestedFocus(
  input: FuseRubricScoreWithRulesInput,
  inputCandidates: {
    triggered: Array<{ gateIds: string[]; rule: RuleAuditResult }>;
    uncertain: Array<{ gateIds: string[]; rule: RuleAuditResult }>;
  },
): string {
  const candidates = [
    ...inputCandidates.triggered,
    ...inputCandidates.uncertain,
  ];
  const gateRules = Array.from(
    new Set(candidates.flatMap((candidate) => candidate.gateIds)),
  )
    .map((gateId) => formatHardGateRule(input, gateId))
    .join("；");
  const triggeredRules = inputCandidates.triggered
    .map((candidate) => candidate.rule.rule_id)
    .join("；");
  const pendingRules = inputCandidates.uncertain
    .map((candidate) => candidate.rule.rule_id)
    .join("；");
  return [
    `硬门槛规则：${gateRules}。`,
    triggeredRules ? `已触发规则 ID：${triggeredRules}。` : "",
    pendingRules ? `待确认规则 ID：${pendingRules}。` : "",
    "请确认这些规则判断是否真实成立，以及是否需要保留或触发对应硬门槛。",
  ].join("");
}

function buildRiskScoreEffect(input: {
  scoringInput: FuseRubricScoreWithRulesInput;
  rule: RuleAuditResult;
  level: string;
  gateIds: string[];
  detailsByKey: Map<string, ScoreFusionDetail>;
}): Record<string, unknown> | undefined {
  const impacts = Array.from(input.detailsByKey.values()).flatMap((detail) =>
    detail.rule_impacts
      .filter(
        (impact) =>
          impact.rule_id === input.rule.rule_id && impact.score_delta !== 0,
      )
      .map((impact) => ({
        dimension_name: detail.dimension_name,
        item_name: detail.item_name,
        original_score_delta: impact.score_delta,
      })),
  );
  if (impacts.length === 0 && input.gateIds.length === 0) {
    return undefined;
  }
  return {
    type: "risk_level_rule_impact",
    rule_id: input.rule.rule_id,
    original_level: input.level,
    hard_gate_ids: input.gateIds,
    hard_gate_active_levels: input.gateIds.length > 0 ? [input.level] : [],
    gate_caps: buildGateCaps(input.scoringInput, input.gateIds),
    impacts,
  };
}

function buildRuleResultReviewItem(input: {
  id: number;
  scoringInput: FuseRubricScoreWithRulesInput;
  rule: RuleAuditResult;
}): HumanReviewItem {
  const hardGateIds = selectRuleTriggeredGateIds(
    input.scoringInput,
    input.rule,
  );
  return {
    id: input.id,
    item: `规则判定复核：${input.rule.rule_id}`,
    current_assessment: input.rule.result,
    uncertainty_reason: input.rule.conclusion,
    suggested_focus: `请人工确认规则 ${input.rule.rule_id} 的判定是否可信，并核对规则结论：${input.rule.conclusion}`,
    score_effect: {
      type: "rule_result",
      rule_ids: [input.rule.rule_id],
      hard_gate_ids: hardGateIds,
      gate_caps: buildGateCaps(input.scoringInput, hardGateIds),
    },
  };
}

function isHvigorBuildHardGateTriggered(
  summary?: HvigorBuildCheckSummary,
): boolean {
  if (!summary) {
    return false;
  }
  return (
    summary.hardGateTriggered ||
    summary.status === "tool_unavailable" ||
    summary.status === "failed" ||
    summary.status === "timeout"
  );
}

function buildHvigorBuildRisk(summary: HvigorBuildCheckSummary): RiskItem {
  const failedModules = summary.moduleResults.filter(
    (result) => result.status === "failed" || result.status === "timeout",
  );
  const sourceLabel =
    summary.buildCheckSource === "remote"
      ? "上游提交的编译结果"
      : summary.buildCheckSource === "agent"
        ? "生成 Agent 编译结果"
        : "hvigor 编译校验";
  const moduleText =
    failedModules.length > 0
      ? failedModules
          .map(
            (result) =>
              `${result.modulePath}:${result.command}:${result.status}`,
          )
          .join("；")
      : summary.checkedModules.join("；") || "未识别模块";
  return {
    id: 0,
    level: "high",
    title: "工程编译校验未通过",
    description: `${sourceLabel}状态为 ${summary.status}，涉及模块：${moduleText}。${
      summary.diagnostics ? ` ${summary.diagnostics}` : ""
    }`,
    evidence: summary.diagnostics ?? moduleText,
  };
}

function buildDeprecatedApiRisk(
  summary: HvigorBuildCheckSummary,
  id: number,
): RiskItem | undefined {
  const warnings = summary.deprecatedApiWarnings ?? [];
  if (warnings.length === 0) {
    return undefined;
  }
  const examples = warnings.slice(0, 3);
  const exampleText = examples
    .map(
      (warning) =>
        `${warning.file}:${String(warning.line)}:${String(warning.column)} '${warning.apiName}'`,
    )
    .join("；");
  const first = warnings[0];
  return {
    id,
    level: "medium",
    title: "新增代码使用废弃 API",
    description: `新增代码使用了 ${String(warnings.length)} 处废弃 API${
      first
        ? `，例如 ${first.file}:${String(first.line)} 的 ${first.apiName}`
        : ""
    }，后续版本可能移除或行为变化。`,
    evidence: `hvigor warning: ${exampleText}`,
    risk_code: "DEPRECATED_API_USAGE",
    risk_category: "medium",
  };
}

function buildHvigorBuildConclusionDetail(
  summary?: HvigorBuildCheckSummary,
): string | undefined {
  const appFailure = summary?.moduleResults.find(
    (result) =>
      result.command === "assembleApp" &&
      (result.status === "failed" || result.status === "timeout"),
  );
  if (!appFailure) {
    return undefined;
  }
  return (
    summary?.diagnostics ??
    appFailure.diagnostics ??
    "整包 assembleApp 编译未通过：组件包可编译，但整包编译未通过，判断为原代码问题，非新增修改引入。"
  );
}

function usePythonScoreFusion(
  input: FuseRubricScoreWithRulesInput,
  computation: ScoreComputation,
): ScoreComputation {
  if (process.env.HMOS_WHITEBOX_PYTHON_SCORE_ENABLE !== "true") {
    return computation;
  }
  const python = process.env.HMOS_WHITEBOX_PYTHON_EXECUTABLE || "python3";
  const exchangeDir = mkdtempSync(path.join(tmpdir(), "whitebox-score-"));
  let pythonScore: ScoreComputation;
  try {
    const inputPath = path.join(exchangeDir, "input.json");
    const outputPath = path.join(exchangeDir, "output.json");
    writeFileSync(inputPath, JSON.stringify({
      input,
      ruleProfiles: Object.fromEntries(ruleProfileById),
      officialProfiles: officialLinterRuleProfiles,
    }), "utf8");
    const run = spawnSync(python, ["-m", "pyautorun.whitebox_score_cli", "--input", inputPath,
      "--output", outputPath], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      env: process.env,
    });
    if (run.error || run.status !== 0) {
      throw new Error(`Python 白盒评分执行失败: ${run.error?.message ?? run.stderr}`);
    }
    pythonScore = JSON.parse(readFileSync(outputPath, "utf8")) as ScoreComputation;
  } finally {
    rmSync(exchangeDir, { recursive: true, force: true });
  }
  const comparison = JSON.parse(JSON.stringify(computation)) as ScoreComputation;
  if (!isDeepStrictEqual(pythonScore, comparison)) {
    const firstDifference = (left: unknown, right: unknown, path: string): string => {
      if (isDeepStrictEqual(left, right)) return "";
      if (left && right && typeof left === "object" && typeof right === "object") {
        const leftRecord = left as Record<string, unknown>;
        const rightRecord = right as Record<string, unknown>;
        for (const key of new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])) {
          const nested = firstDifference(leftRecord[key], rightRecord[key], `${path}.${key}`);
          if (nested) return nested;
        }
      }
      return path;
    };
    throw new Error(`Python 与 Node 白盒评分融合结果不一致: ${firstDifference(pythonScore, comparison, "result")}`);
  }
  return pythonScore;
}

export function fuseRubricScoreWithRules(
  input: FuseRubricScoreWithRulesInput,
): ScoreComputation {
  const criteriaByMetric = buildCriteriaByMetric(input.rubricSnapshot);
  const scoringBandsByMetric = buildScoringBandsByMetric(input.rubricSnapshot);
  const baseItems = selectBaseItems(input);
  const detailsByKey = new Map<string, ScoreFusionDetail>();

  for (const item of baseItems) {
    const key = makeMetricKey(item.dimension_name, item.item_name);
    detailsByKey.set(key, {
      dimension_name: item.dimension_name,
      item_name: item.item_name,
      agent_evaluation: {
        base_score: item.score,
        matched_band_score: item.matched_band_score,
        matched_criteria: criteriaByMetric.get(key) ?? "",
        logic: item.rationale,
        evidence_used: item.evidence_used,
        confidence: item.confidence,
        deduction_trace: item.deduction_trace ?? null,
      },
      rule_impacts: [],
      score_fusion: {
        base_score: item.score,
        rule_delta: 0,
        final_score: item.score,
        fusion_logic:
          "未命中影响该评分项的规则，最终分等于 rubric agent 基础分。",
      },
    });
  }

  const ruleCanonicalIssueIds = new Set(
    input.ruleAuditResults.flatMap((rule) => {
      if (rule.result !== "不满足") {
        return [];
      }
      const issue = buildRuleCanonicalIssue({
        rule,
        taxonomy: input.riskTaxonomy,
        taskType: input.taskType,
      });
      return issue ? [issue.issueId] : [];
    }),
  );
  const risks: RiskItem[] = (input.rubricScoringResult?.risks ?? [])
    .map((risk, index) => {
      const withId = { ...risk, id: index + 1 };
      return input.riskTaxonomy
        ? normalizeRiskItem(withId, input.riskTaxonomy)
        : withId;
    })
    .filter((risk) => {
      const issue = buildRubricCanonicalIssue({
        risk,
        taxonomy: input.riskTaxonomy,
        taskType: input.taskType,
      });
      return !issue || !ruleCanonicalIssueIds.has(issue.issueId);
    });
  const hvigorHardGateTriggered = isHvigorBuildHardGateTriggered(
    input.hvigorBuildCheckSummary,
  );
  if (hvigorHardGateTriggered && input.hvigorBuildCheckSummary) {
    risks.push({
      ...buildHvigorBuildRisk(input.hvigorBuildCheckSummary),
      id: risks.length + 1,
    });
  }
  if (input.hvigorBuildCheckSummary) {
    const deprecatedApiRisk = buildDeprecatedApiRisk(
      input.hvigorBuildCheckSummary,
      risks.length + 1,
    );
    if (deprecatedApiRisk) {
      risks.push(deprecatedApiRisk);
    }
  }

  for (const rule of input.ruleAuditResults) {
    if (rule.result !== "不满足" && rule.result !== "待人工复核") {
      continue;
    }

    const penaltyRules = findPenaltyRules(rule);
    for (const detail of detailsByKey.values()) {
      const penalty = penaltyRules.find((candidate) =>
        candidate.metricNames.includes(detail.item_name),
      );
      if (!penalty) {
        continue;
      }

      const delta =
        rule.result === "待人工复核"
          ? 0
          : -roundScore(detail.agent_evaluation.base_score * penalty.ratio);
      detail.rule_impacts.push({
        rule_id: rule.rule_id,
        rule_source: rule.rule_source,
        result: rule.result,
        severity:
          rule.result === "待人工复核" ? "review_only" : penalty.severity,
        score_delta: delta,
        agent_assisted: rule.rule_source === "should_rule",
        needs_human_review: rule.result === "待人工复核",
      });
    }

    if (rule.result === "不满足") {
      const level = riskLevelFromRuleImpact(rule, penaltyRules);
      const gateIds = selectRuleTriggeredGateIds(input, rule);
      risks.push({
        id: risks.length + 1,
        level,
        title: `规则违规：${rule.rule_id}`,
        risk_code: `RULE_VIOLATION:${rule.rule_id}`,
        risk_category: level as "low" | "medium" | "high",
        source_rule_id: rule.rule_id,
        evidence: rule.conclusion,
        score_effect: buildRiskScoreEffect({
          scoringInput: input,
          rule,
          level,
          gateIds,
          detailsByKey,
        }),
      });
    }
  }

  const scoreFusionDetails = Array.from(detailsByKey.values()).map((detail) => {
    const metricKey = makeMetricKey(detail.dimension_name, detail.item_name);
    const scoringBands = scoringBandsByMetric.get(metricKey) ?? [];
    const ruleDelta = roundScore(
      detail.rule_impacts.reduce((sum, impact) => sum + impact.score_delta, 0),
    );
    const rawFinalScore = roundScore(
      Math.max(0, detail.agent_evaluation.base_score + ruleDelta),
    );
    const finalScore = snapScoreToDeclaredBand(rawFinalScore, scoringBands);
    return {
      ...detail,
      score_fusion: {
        base_score: detail.agent_evaluation.base_score,
        rule_delta: ruleDelta,
        final_score: finalScore,
        fusion_logic:
          ruleDelta === 0
            ? "未命中影响该评分项的规则，最终分等于 rubric agent 基础分。"
            : rawFinalScore === finalScore
              ? `rubric agent 基础分 ${detail.agent_evaluation.base_score}，规则修正 ${ruleDelta}，最终 ${finalScore}。`
              : `rubric agent 基础分 ${detail.agent_evaluation.base_score}，规则修正 ${ruleDelta}，原始结果 ${rawFinalScore}，按 rubric 档位收敛为 ${finalScore}。`,
      },
    };
  });

  const dimensionScores: DimensionScore[] = input.rubric.dimensions.map(
    (dimension) => {
      const metrics = scoreFusionDetails.filter(
        (detail) => detail.dimension_name === dimension.name,
      );
      const score = roundScore(
        metrics.reduce(
          (sum, detail) => sum + detail.score_fusion.final_score,
          0,
        ),
      );
      return {
        dimension_name: dimension.name,
        score,
        max_score: dimension.weight,
        comment: metrics.some((metric) => metric.rule_impacts.length > 0)
          ? "包含规则修正项。"
          : "未发现规则修正项。",
      };
    },
  );

  const submetricDetails: SubmetricDetail[] = scoreFusionDetails.map(
    (detail) => ({
      dimension_name: detail.dimension_name,
      metric_name: detail.item_name,
      score: detail.score_fusion.final_score,
      confidence: detail.agent_evaluation.confidence,
      review_required:
        detail.agent_evaluation.confidence === "low" ||
        detail.rule_impacts.some((impact) => impact.needs_human_review),
      rationale: detail.score_fusion.fusion_logic,
      evidence: [
        ...detail.agent_evaluation.evidence_used,
        ...detail.rule_impacts.map((impact) => impact.rule_id),
      ].join(" "),
    }),
  );

  const rawTotalScore = roundScore(
    dimensionScores.reduce((sum, dimension) => sum + dimension.score, 0),
  );
  const triggeredGateIds = selectTriggeredGateIds(input);
  const scoreCap = triggeredGateIds
    .map(
      (gateId) =>
        input.rubric.hardGates.find((gate) => gate.id === gateId)?.scoreCap,
    )
    .filter((value): value is number => typeof value === "number")
    .concat(
      hvigorHardGateTriggered
        ? [input.hvigorBuildCheckSummary?.scoreCap ?? 59]
        : [],
    )
    .reduce<number | undefined>(
      (minCap, current) =>
        minCap === undefined ? current : Math.min(minCap, current),
      undefined,
    );
  const totalScore =
    scoreCap === undefined ? rawTotalScore : Math.min(rawTotalScore, scoreCap);
  const hardGateReasons = [
    ...triggeredGateIds,
    ...(hvigorHardGateTriggered ? ["BUILD-CHECK"] : []),
  ];
  const hvigorConclusionDetail = hvigorHardGateTriggered
    ? buildHvigorBuildConclusionDetail(input.hvigorBuildCheckSummary)
    : undefined;
  const hardGates = buildTriggeredHardGateDetails(
    input,
    triggeredGateIds,
    hvigorHardGateTriggered,
  );
  const triggeredHardGateCandidates = selectTriggeredHardGateCandidates(input);
  const uncertainHardGateCandidates = selectUncertainHardGateCandidates(input);
  const humanReviewItems: HumanReviewItem[] =
    input.rubricAgentRunStatus === "success"
      ? []
      : [
          {
            id: 1,
            item: "Rubric Agent 降级",
            current_assessment:
              "rubric agent 未产出可信扣分依据，当前按满分保留。",
            uncertainty_reason: `rubricAgentRunStatus=${input.rubricAgentRunStatus}`,
            suggested_focus: "人工复核 rubric 逐项评分是否合理。",
          },
        ];
  if (
    triggeredHardGateCandidates.length > 0 ||
    uncertainHardGateCandidates.length > 0
  ) {
    const candidateGateIds = Array.from(
      new Set(
        [
          ...triggeredHardGateCandidates,
          ...uncertainHardGateCandidates,
        ].flatMap((candidate) => candidate.gateIds),
      ),
    );
    const currentGateIds = Array.from(
      new Set(
        triggeredHardGateCandidates.flatMap((candidate) => candidate.gateIds),
      ),
    );
    const firstTriggeredGate = currentGateIds[0];
    const firstTriggeredGateDetail = firstTriggeredGate
      ? buildHardGateTriggerDetail(
          input,
          firstTriggeredGate as "G1" | "G2" | "G3" | "G4",
        )
      : undefined;
    const triggeredRuleIds = Array.from(
      new Set(
        triggeredHardGateCandidates.map((candidate) => candidate.rule.rule_id),
      ),
    );
    const triggerPolicy = firstTriggeredGateDetail?.trigger_policy as
      | Record<string, unknown>
      | undefined;
    humanReviewItems.push({
      id: humanReviewItems.length + 1,
      item: "硬门槛复核",
      current_assessment:
        currentGateIds.length > 0 ? currentGateIds.join(",") : "none",
      uncertainty_reason:
        currentGateIds.length > 0 && firstTriggeredGateDetail
          ? `${firstTriggeredGateDetail.id} ${firstTriggeredGateDetail.name}：${
              firstTriggeredGateDetail.trigger_reason
            }。`
          : `以下规则可能触发硬门槛但 agent 无法确认：${uncertainHardGateCandidates
              .map((candidate) => candidate.rule.rule_id)
              .join(", ")}。`,
      suggested_focus: buildHardGateSuggestedFocus(input, {
        triggered: triggeredHardGateCandidates,
        uncertain: uncertainHardGateCandidates,
      }),
      score_effect: {
        type: "hard_gate",
        gate_ids: candidateGateIds,
        gate_caps: buildGateCaps(input, candidateGateIds),
        ...(firstTriggeredGateDetail?.trigger_reason
          ? { trigger_reason: firstTriggeredGateDetail.trigger_reason }
          : {}),
        ...(triggerPolicy ? { trigger_policy: triggerPolicy } : {}),
        ...(currentGateIds.length > 0
          ? { triggered_rule_ids: triggeredRuleIds }
          : {}),
      },
    });
  }
  for (const rule of input.ruleAuditResults) {
    if (rule.result !== "待人工复核") {
      continue;
    }
    humanReviewItems.push(
      buildRuleResultReviewItem({
        id: humanReviewItems.length + 1,
        scoringInput: input,
        rule,
      }),
    );
  }

  const computation: ScoreComputation = {
    totalScore,
    hardGateTriggered: hardGateReasons.length > 0,
    hardGateReason: hardGateReasons.join(", "),
    overallConclusion: {
      total_score: totalScore,
      pre_cap_score: rawTotalScore,
      hard_gate_triggered: hardGateReasons.length > 0,
      hard_gates: hardGates,
      summary:
        hardGateReasons.length > 0
          ? `已完成 rubric 基础评分与规则修正融合，并触发硬门槛：${hardGateReasons.join(", ")}。${
              hvigorConclusionDetail ? ` ${hvigorConclusionDetail}` : ""
            }`
          : "已完成 rubric 基础评分与规则修正融合。",
    },
    dimensionScores,
    submetricDetails,
    scoreFusionDetails,
    risks,
    humanReviewItems,
    strengths: input.rubricScoringResult?.strengths ?? [],
    mainIssues: input.rubricScoringResult?.main_issues ?? [],
    finalRecommendation: ["当前分数可作为 rubric-first 自动预检结果使用。"],
  };
  return usePythonScoreFusion(input, computation);
}

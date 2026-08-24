import {
  CaseRuleDefinition,
  ConstraintSummary,
  DimensionScore,
  EvidenceSummary,
  HumanReviewItem,
  RiskItem,
  RuleAuditResult,
  RuleImpactDetail,
  RuleViolation,
  ScoreComputation,
  ScoreFusionDetail,
  SubmetricDetail,
  TaskType,
} from "../types.js";
import { LoadedRubric } from "./rubricLoader.js";
import {
  findOfficialLinterRuleProfile,
  officialLinterSeverityToImpactSeverity,
} from "./officialLinterRuleProfiles.js";

type ComputeScoreInput = {
  taskType: TaskType;
  rubric: LoadedRubric;
  ruleAuditResults: RuleAuditResult[];
  ruleViolations: RuleViolation[];
  constraintSummary: ConstraintSummary;
  evidenceSummary: EvidenceSummary;
  caseRuleDefinitions?: CaseRuleDefinition[];
};

type MetricPenaltyRule = {
  metricNames: string[];
  ratio: number;
  confidence: "medium" | "low";
  reviewRequired: boolean;
  severity?: RuleImpactDetail["severity"];
};

type GateTrigger = {
  id: "G1" | "G2" | "G3" | "G4";
  reason: string;
};

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function makeMetricKey(dimensionName: string, metricName: string): string {
  return `${dimensionName}::${metricName}`;
}

function formatScoringBands(scoringBands: Array<{ score: number; criteria: string }>): string {
  return scoringBands.map((band) => `${band.score}分：${band.criteria}`).join(" / ");
}

function getInitialMetricScore(item: LoadedRubric["dimensions"][number]["items"][number]): number {
  if (item.scoringBands.length === 0) {
    return item.weight;
  }
  return Math.max(...item.scoringBands.map((band) => band.score));
}

function snapScoreToDeclaredBand(score: number, scoringBands: Array<{ score: number }>): number {
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

const typeSafetyMetrics = ["ArkTS/ArkUI语法与类型安全", "ArkTS约束遵循度", "ArkTS/ArkUI规范符合度"];
const staticQualityMetrics = ["静态坏味道控制"];
const namingMetrics = ["命名表达清晰度", "命名与风格一致性"];
const complexityMetrics = ["复杂度控制"];
const stateFlowMetrics = ["状态与数据流组织", "状态接入合理性"];
const stabilityRiskMetrics = ["稳定性风险", "回归风险控制"];
const securityBoundaryMetrics = ["安全与边界意识", "安全/边界意识"];
const performanceRiskMetrics = ["性能风险"];

function makePenaltyRule(input: {
  metricNames: string[];
  ratio: number;
  confidence?: "medium" | "low";
  reviewRequired?: boolean;
}): MetricPenaltyRule[] {
  return [
    {
      metricNames: input.metricNames,
      ratio: input.ratio,
      confidence: input.confidence ?? "medium",
      reviewRequired: input.reviewRequired ?? true,
    },
  ];
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
    return [
      {
        metricNames: officialProfile.metricNames,
        ratio: officialProfile.ratio,
        confidence: severity === "heavy" ? "low" : "medium",
        reviewRequired: severity !== "light",
        severity,
      },
    ];
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
          ? [...typeSafetyMetrics, ...stabilityRiskMetrics, ...securityBoundaryMetrics]
          : typeSafetyMetrics,
      ratio: rule.rule_source === "must_rule" ? 0.35 : 0.15,
      confidence: rule.rule_source === "forbidden_pattern" ? "low" : "medium",
      reviewRequired: rule.rule_source !== "should_rule",
    });
  }
  if (namingRuleIds.has(rule.rule_id)) {
    return makePenaltyRule({
      metricNames: namingMetrics,
      ratio: 0.15,
      reviewRequired: false,
    });
  }
  if (styleRuleIds.has(rule.rule_id)) {
    return makePenaltyRule({
      metricNames: staticQualityMetrics,
      ratio: rule.rule_source === "must_rule" ? 0.25 : 0.15,
      reviewRequired: rule.rule_source === "must_rule",
    });
  }
  if (controlFlowRuleIds.has(rule.rule_id)) {
    return makePenaltyRule({
      metricNames: [...complexityMetrics, ...staticQualityMetrics, ...stabilityRiskMetrics],
      ratio: rule.rule_source === "forbidden_pattern" ? 0.5 : 0.25,
      confidence: rule.rule_source === "forbidden_pattern" ? "low" : "medium",
    });
  }
  if (rule.rule_id === "ARKTS-PERF-FORBID-001") {
    return makePenaltyRule({
      metricNames: [...performanceRiskMetrics, ...typeSafetyMetrics],
      ratio: 0.5,
      confidence: "low",
    });
  }
  if (runtimeRiskRuleIds.has(rule.rule_id)) {
    return makePenaltyRule({
      metricNames: [...stabilityRiskMetrics, ...securityBoundaryMetrics, ...typeSafetyMetrics],
      ratio: rule.rule_source === "forbidden_pattern" ? 0.5 : 0.35,
      confidence: rule.rule_source === "forbidden_pattern" ? "low" : "medium",
    });
  }
  if (rule.rule_id === "ARKTS-SHOULD-001") {
    return makePenaltyRule({
      metricNames: [...stateFlowMetrics, ...stabilityRiskMetrics],
      ratio: 0.15,
      reviewRequired: false,
    });
  }

  if (rule.rule_source === "must_rule") {
    return makePenaltyRule({ metricNames: typeSafetyMetrics, ratio: 0.35 });
  }
  if (rule.rule_source === "forbidden_pattern") {
    return makePenaltyRule({
      metricNames: [...stabilityRiskMetrics, ...securityBoundaryMetrics],
      ratio: 0.5,
      confidence: "low",
    });
  }
  return [];
}

function selectTriggeredGates(input: ComputeScoreInput): GateTrigger[] {
  // 这里保留确定性触发条件，避免首版因为复杂推理而难以验证。
  const violatedRules = input.ruleAuditResults.filter((rule) => rule.result === "不满足");
  const mustViolations = violatedRules.filter((rule) => rule.rule_source === "must_rule");
  const forbiddenViolations = violatedRules.filter(
    (rule) => rule.rule_source === "forbidden_pattern",
  );
  const triggered: GateTrigger[] = [];
  const caseMustRuleIds = new Set(
    (input.caseRuleDefinitions ?? [])
      .filter((rule) => rule.priority === "P0")
      .map((rule) => rule.rule_id),
  );

  if (violatedRules.some((rule) => caseMustRuleIds.has(rule.rule_id) && rule.result === "不满足")) {
    triggered.push({ id: "G1", reason: "case_rule: 存在 P0 用例约束不满足。" });
  }

  if (mustViolations.length >= 2) {
    triggered.push({ id: "G1", reason: "存在多条 must_rule 违规，说明静态质量问题较为集中。" });
  }

  if (
    mustViolations.some((rule) =>
      ["ARKTS-FORBID-003", "ARKTS-FORBID-004", "ARKTS-FORBID-005"].includes(rule.rule_id),
    )
  ) {
    triggered.push({ id: "G2", reason: "命中了核心 ArkTS 约束违规，说明实现与平台规则存在偏差。" });
  }

  if (forbiddenViolations.length > 0) {
    triggered.push({ id: "G3", reason: "命中了 forbidden_pattern 违规，工程风险较高。" });
  }

  if (
    input.taskType === "bug_fix" &&
    (input.evidenceSummary.changedFileCount > 8 || input.evidenceSummary.changedFiles.length > 8)
  ) {
    triggered.push({ id: "G4", reason: "bug_fix 改动文件过多，存在过度修复风险。" });
  }

  return triggered;
}

function getRuleImpactSeverity(rule: RuleAuditResult): RuleImpactDetail["severity"] {
  if (rule.rule_source === "forbidden_pattern") {
    return "heavy";
  }
  if (rule.rule_source === "must_rule") {
    return "medium";
  }
  return "light";
}

function riskLevelFromRuleImpact(rule: RuleAuditResult, penaltyRules: MetricPenaltyRule[]): string {
  const severities = penaltyRules.map((penalty) => penalty.severity ?? getRuleImpactSeverity(rule));
  if (severities.some((severity) => severity === "heavy")) {
    return "high";
  }
  if (severities.some((severity) => severity === "medium")) {
    return "medium";
  }
  if (severities.some((severity) => severity === "light")) {
    return "low";
  }
  return rule.rule_source === "forbidden_pattern" ? "high" : "medium";
}

function shouldForceReview(
  score: number,
  scoreBands: Array<{ min: number; max: number }>,
): boolean {
  return scoreBands.some((band) => score >= band.min && score <= band.max);
}

export function computeScoreBreakdown(input: ComputeScoreInput): ScoreComputation {
  const rubricItemMap = new Map(
    input.rubric.dimensions.flatMap((dimension) =>
      dimension.items.map((item) => [makeMetricKey(dimension.name, item.name), item] as const),
    ),
  );
  // 所有子指标先按 rubric 满分初始化，再叠加规则修正。
  const details: SubmetricDetail[] = input.rubric.dimensions.flatMap((dimension) =>
    dimension.items.map((item) => ({
      dimension_name: dimension.name,
      metric_name: item.name,
      score: getInitialMetricScore(item),
      confidence: "high" as const,
      review_required: false,
      rationale: "按 rubric 基线满分初始化。",
      evidence: "当前未命中扣分证据。",
    })),
  );
  const scoreFusionDetails: ScoreFusionDetail[] = input.rubric.dimensions.flatMap((dimension) =>
    dimension.items.map((item) => {
      const baseScore = getInitialMetricScore(item);
      return {
        dimension_name: dimension.name,
        item_name: item.name,
        agent_evaluation: {
          base_score: baseScore,
          matched_band_score: baseScore,
          matched_criteria: formatScoringBands(item.scoringBands),
          logic: "按 rubric 基线满分初始化；规则评判仅作为后续修正信号。",
          evidence_used: [],
          confidence: "high" as const,
          deduction_trace: null,
        },
        rule_impacts: [],
        score_fusion: {
          base_score: baseScore,
          rule_delta: 0,
          final_score: baseScore,
          fusion_logic: "未命中影响该评分项的规则，最终分等于 rubric 基础分。",
        },
      };
    }),
  );

  const detailMap = new Map(
    details.map((detail) => [makeMetricKey(detail.dimension_name, detail.metric_name), detail]),
  );
  const scoreFusionDetailMap = new Map(
    scoreFusionDetails.map((detail) => [
      makeMetricKey(detail.dimension_name, detail.item_name),
      detail,
    ]),
  );
  const risks: RiskItem[] = [];
  const humanReviewItems: HumanReviewItem[] = [];

  for (const rule of input.ruleAuditResults) {
    if (rule.result !== "不满足") {
      continue;
    }

    const penaltyRules = findPenaltyRules(rule);
    for (const detail of details) {
      const penalty = penaltyRules.find((candidate) =>
        candidate.metricNames.includes(detail.metric_name),
      );
      if (!penalty) {
        continue;
      }

      const current = detailMap.get(makeMetricKey(detail.dimension_name, detail.metric_name));
      if (!current) {
        continue;
      }

      const maxScore = rubricItemMap.get(
        makeMetricKey(detail.dimension_name, detail.metric_name),
      )?.weight;
      if (maxScore === undefined) {
        continue;
      }

      const nextScore = Math.max(maxScore * 0.2, current.score - maxScore * penalty.ratio);
      current.score = roundScore(nextScore);
      current.confidence = penalty.confidence;
      current.review_required = penalty.reviewRequired;
      // rationale/evidence 直接回指触发的规则，便于 report 层透明展示。
      current.rationale = `${rule.rule_id} 触发了 ${rule.rule_source} 扣分。`;
      current.evidence = rule.conclusion;

      const fusionDetail = scoreFusionDetailMap.get(
        makeMetricKey(detail.dimension_name, detail.metric_name),
      );
      if (fusionDetail) {
        fusionDetail.rule_impacts.push({
          rule_id: rule.rule_id,
          rule_source: rule.rule_source,
          result: "不满足",
          severity: penalty.severity ?? getRuleImpactSeverity(rule),
          score_delta: -roundScore(maxScore * penalty.ratio),
          agent_assisted: rule.rule_source === "should_rule",
          needs_human_review: penalty.reviewRequired,
        });
      }
    }

    risks.push({
      id: risks.length + 1,
      level: riskLevelFromRuleImpact(rule, penaltyRules),
      title: `规则违规：${rule.rule_id}`,
      description: rule.conclusion,
      evidence: rule.conclusion,
    });
  }

  for (const detail of details) {
    const rubricItem = rubricItemMap.get(makeMetricKey(detail.dimension_name, detail.metric_name));
    detail.score = snapScoreToDeclaredBand(detail.score, rubricItem?.scoringBands ?? []);

    const fusionDetail = scoreFusionDetailMap.get(
      makeMetricKey(detail.dimension_name, detail.metric_name),
    );
    if (fusionDetail) {
      const baseScore = fusionDetail.agent_evaluation.base_score;
      const ruleDelta = roundScore(detail.score - baseScore);
      fusionDetail.agent_evaluation.confidence = detail.confidence;
      fusionDetail.score_fusion = {
        base_score: baseScore,
        rule_delta: ruleDelta,
        final_score: detail.score,
        fusion_logic:
          ruleDelta === 0
            ? "未命中影响该评分项的规则，最终分等于 rubric 基础分。"
            : `rubric 基础分 ${baseScore}，规则修正 ${ruleDelta}，最终 ${detail.score}。`,
      };
    }
  }

  const dimensionScores: DimensionScore[] = input.rubric.dimensions.map((dimension) => {
    const metrics = details.filter((detail) => detail.dimension_name === dimension.name);
    const score = roundScore(metrics.reduce((sum, detail) => sum + detail.score, 0));
    return {
      dimension_name: dimension.name,
      score,
      max_score: dimension.weight,
      comment: metrics.some((metric) => metric.review_required)
        ? "包含需要人工复核的扣分项。"
        : "未发现高风险扣分项。",
    };
  });

  const rawTotalScore = roundScore(
    dimensionScores.reduce((sum, dimension) => sum + dimension.score, 0),
  );
  const triggeredGates = selectTriggeredGates(input);
  const scoreCap = triggeredGates
    .map((trigger) => input.rubric.hardGates.find((gate) => gate.id === trigger.id)?.scoreCap)
    .filter((value): value is number => typeof value === "number")
    .reduce<number | undefined>(
      (minCap, current) => (minCap === undefined ? current : Math.min(minCap, current)),
      undefined,
    );
  // 总分先聚合，再应用最严格的硬门槛 cap。
  const totalScore = scoreCap === undefined ? rawTotalScore : Math.min(rawTotalScore, scoreCap);

  if (triggeredGates.length > 0) {
    humanReviewItems.push({
      id: humanReviewItems.length + 1,
      item: "硬门槛复核",
      current_assessment: triggeredGates.map((gate) => gate.id).join(", "),
      uncertainty_reason: triggeredGates.map((gate) => gate.reason).join(" "),
      suggested_focus: "确认触发的硬门槛是否真实反映当前实现的主要风险。",
    });
  }

  if (!input.evidenceSummary.hasPatch && input.taskType !== "full_generation") {
    humanReviewItems.push({
      id: humanReviewItems.length + 1,
      item: "Patch 上下文缺失",
      current_assessment: "当前 continuation 或 bug_fix 评分时缺少 patch 文件。",
      uncertainty_reason: "变更范围证据不完整。",
      suggested_focus: "请结合 original 工程人工核对改动文件。",
    });
  }

  if (
    details.some((detail) => detail.confidence === "low") ||
    shouldForceReview(totalScore, input.rubric.reviewRules.scoreBands)
  ) {
    humanReviewItems.push({
      id: humanReviewItems.length + 1,
      item: "置信度复核",
      current_assessment: `当前总分为 ${totalScore}。`,
      uncertainty_reason: "存在低置信度指标，或分数落在需要人工确认的关键分段。",
      suggested_focus: "重点复核低置信度指标以及临近 score cap 的阈值。",
    });
  }

  return {
    totalScore,
    hardGateTriggered: triggeredGates.length > 0,
    hardGateReason: triggeredGates.map((gate) => `${gate.id}: ${gate.reason}`).join(" "),
    overallConclusion: {
      total_score: totalScore,
      pre_cap_score: rawTotalScore,
      hard_gate_triggered: triggeredGates.length > 0,
      hard_gates: triggeredGates.map((gate) => ({
        id: gate.id,
        trigger_reason: gate.reason,
      })),
      summary:
        triggeredGates.length > 0
          ? `触发硬门槛：${triggeredGates.map((gate) => `${gate.id}: ${gate.reason}`).join(" ")}`
          : "未触发硬门槛，当前评分可作为自动预检结果。",
    },
    dimensionScores,
    submetricDetails: details,
    scoreFusionDetails,
    risks,
    humanReviewItems,
    strengths: input.ruleAuditResults.every((rule) => rule.result !== "不满足")
      ? ["已支持的规则集中未检测到违规项。"]
      : ["工作流已采集规则级证据，并将其传递到评分拆解结果中。"],
    mainIssues: input.ruleAuditResults
      .filter((rule) => rule.result === "不满足")
      .slice(0, 5)
      .map((rule) => `${rule.rule_id}: ${rule.conclusion}`),
    finalRecommendation:
      triggeredGates.length > 0
        ? ["在将该分数用于自动排序前，必须先进行人工复核。"]
        : ["当前分数可作为自动预检基线使用。"],
  };
}

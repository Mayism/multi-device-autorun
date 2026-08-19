import {
  getEnabledRulePacks,
  listRegisteredRules,
  resolveEnabledRulePackIds,
} from "../../../rules/registry/rulePackRegistry.js";
import { officialCodeLinterRecommendedRuleSets } from "../../../rules/official-linter/config/recommendedRuleSets.js";
import type {
  ConfidenceLevel,
  HvigorBuildCheckSummary,
  OfficialLinterFinding,
  RuleAuditResult,
  ScoreFusionDetail,
} from "../../../types.js";
import type { ScoreGraphState } from "../../graph/state.js";

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function makeMetricKey(dimensionName: string, metricName: string): string {
  return `${dimensionName}::${metricName}`;
}

function combineConfidence(details: ScoreFusionDetail[]): ConfidenceLevel {
  if (
    details.length === 0 ||
    details.some((detail) => detail.agent_evaluation.confidence === "low")
  ) {
    return "low";
  }
  if (details.some((detail) => detail.agent_evaluation.confidence === "medium")) {
    return "medium";
  }
  return "high";
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function buildAgentEvaluationSummary(details: ScoreFusionDetail[]): Record<string, unknown> {
  const baseScore = roundScore(
    details.reduce((sum, detail) => sum + detail.agent_evaluation.base_score, 0),
  );
  const logic = uniqueStrings(details.map((detail) => detail.agent_evaluation.logic));
  const keyEvidence = uniqueStrings(
    details.flatMap((detail) => detail.agent_evaluation.evidence_used),
  );

  return {
    base_score: baseScore,
    logic:
      logic.length > 0 ? logic.join(" ") : "缺少 rubric agent 评价明细，需人工复核该维度评分依据。",
    key_evidence: keyEvidence,
    confidence: combineConfidence(details),
  };
}

function buildRuleViolationSummary(details: ScoreFusionDetail[]): Record<string, unknown> {
  const violatedRuleIds = new Set(
    details.flatMap((detail) =>
      detail.rule_impacts
        .filter((impact) => impact.result === "不满足")
        .map((impact) => impact.rule_id),
    ),
  );
  const affectedItemCount = details.filter((detail) => detail.rule_impacts.length > 0).length;
  const totalRuleDelta = roundScore(
    details.reduce((sum, detail) => sum + detail.score_fusion.rule_delta, 0),
  );

  return {
    violated_rule_count: violatedRuleIds.size,
    affected_item_count: affectedItemCount,
    total_rule_delta: totalRuleDelta,
    summary:
      violatedRuleIds.size === 0
        ? "该维度未发现规则违规对评分项产生扣分影响。"
        : `该维度共有 ${violatedRuleIds.size} 条违规规则影响 ${affectedItemCount} 个评分项，累计规则修正 ${totalRuleDelta} 分。`,
  };
}

type DimensionSummary = NonNullable<
  ScoreGraphState["rubricSnapshot"]
>["dimension_summaries"][number];
type ItemSummary = DimensionSummary["item_summaries"][number];
type ScoreFusionDetailMap = Map<string, ScoreFusionDetail>;

function findSubmetricDetail(state: ScoreGraphState, dimensionName: string, itemName: string) {
  return state.scoreComputation.submetricDetails.find(
    (item) => item.dimension_name === dimensionName && item.metric_name === itemName,
  );
}

function buildFallbackAgentEvaluation() {
  return {
    base_score: 0,
    matched_band_score: 0,
    matched_criteria: "",
    logic: "缺少 rubric agent 对该评分项的评价逻辑。",
    evidence_used: [],
    deduction_trace: null,
    confidence: "low",
  };
}

function pickMatchedBand(input: {
  itemSummary: ItemSummary;
  itemScore: number;
  fusionDetail?: ScoreFusionDetail;
}) {
  return (
    input.itemSummary.scoring_bands.find((band) => band.score === input.itemScore) ??
    input.itemSummary.scoring_bands.find(
      (band) => band.score === input.fusionDetail?.agent_evaluation.matched_band_score,
    ) ??
    null
  );
}

function shouldRequireReview(input: {
  detail: ReturnType<typeof findSubmetricDetail>;
  fusionDetail?: ScoreFusionDetail;
}): boolean {
  return (
    input.detail?.review_required ??
    input.fusionDetail?.rule_impacts.some((impact) => impact.needs_human_review) ??
    true
  );
}

function buildFallbackScoreFusion(detail: ReturnType<typeof findSubmetricDetail>) {
  return {
    base_score: 0,
    rule_delta: 0,
    final_score: detail?.score ?? 0,
    fusion_logic: "缺少评分融合明细，需人工复核该评分项。",
  };
}

function buildDimensionItemResult(input: {
  state: ScoreGraphState;
  dimensionName: string;
  itemSummary: ItemSummary;
  scoreFusionDetailMap: ScoreFusionDetailMap;
}): Record<string, unknown> {
  const detail = findSubmetricDetail(input.state, input.dimensionName, input.itemSummary.name);
  const fusionDetail = input.scoreFusionDetailMap.get(
    makeMetricKey(input.dimensionName, input.itemSummary.name),
  );
  const itemScore = fusionDetail?.score_fusion.final_score ?? detail?.score ?? 0;
  return {
    item_name: input.itemSummary.name,
    item_weight: input.itemSummary.weight,
    score: itemScore,
    matched_band: pickMatchedBand({ itemSummary: input.itemSummary, itemScore, fusionDetail }),
    confidence: fusionDetail?.agent_evaluation.confidence ?? detail?.confidence ?? "low",
    review_required: shouldRequireReview({ detail, fusionDetail }),
    agent_evaluation: fusionDetail?.agent_evaluation ?? buildFallbackAgentEvaluation(),
    rule_impacts: fusionDetail?.rule_impacts ?? [],
    score_fusion: fusionDetail?.score_fusion ?? buildFallbackScoreFusion(detail),
  };
}

function buildOneDimensionResult(
  state: ScoreGraphState,
  dimensionSummary: DimensionSummary,
  scoreFusionDetailMap: ScoreFusionDetailMap,
): Record<string, unknown> {
  const dimensionScore = state.scoreComputation.dimensionScores.find(
    (item) => item.dimension_name === dimensionSummary.name,
  );
  const dimensionFusionDetails = state.scoreComputation.scoreFusionDetails.filter(
    (detail) => detail.dimension_name === dimensionSummary.name,
  );
  return {
    dimension_name: dimensionSummary.name,
    dimension_intent: dimensionSummary.intent,
    score: dimensionScore?.score ?? 0,
    max_score: dimensionScore?.max_score ?? dimensionSummary.weight,
    comment: dimensionScore?.comment ?? "",
    agent_evaluation_summary: buildAgentEvaluationSummary(dimensionFusionDetails),
    rule_violation_summary: buildRuleViolationSummary(dimensionFusionDetails),
    item_results: dimensionSummary.item_summaries.map((itemSummary) =>
      buildDimensionItemResult({
        state,
        dimensionName: dimensionSummary.name,
        itemSummary,
        scoreFusionDetailMap,
      }),
    ),
  };
}

/** 构造 result.json 中的维度和评分项明细。 */
export function buildDimensionResults(state: ScoreGraphState): Array<Record<string, unknown>> {
  const rubricSummary = state.rubricSnapshot;
  const scoreFusionDetails = state.scoreComputation.scoreFusionDetails;
  const scoreFusionDetailMap = new Map(
    scoreFusionDetails.map((detail) => [
      makeMetricKey(detail.dimension_name, detail.item_name),
      detail,
    ]),
  );

  return (rubricSummary?.dimension_summaries ?? []).map((dimensionSummary) =>
    buildOneDimensionResult(state, dimensionSummary, scoreFusionDetailMap),
  );
}

function normalizeRulePackVersion(version: string | undefined): string | undefined {
  const trimmed = version?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

function formatCaseRulePackDisplayName(packId: string, caseId: string): string {
  if (packId.startsWith("case-") && packId.length > "case-".length) {
    return `用例 ${packId.slice("case-".length)} 约束规则`;
  }
  return `用例 ${caseId} 约束规则`;
}

/** 汇总本次评分实际启用的内置规则包和用例约束规则包。 */
export function buildBoundRulePacks(state: ScoreGraphState): Array<Record<string, string>> {
  const builtInPacks =
    state.enabledRulePacks ??
    getEnabledRulePacks(
      resolveEnabledRulePackIds({
        crossDeviceAdaptation: state.taskUnderstanding?.crossDeviceAdaptation,
      }),
    ).map((pack) => ({
      pack_id: pack.packId,
      display_name: pack.displayName,
      ...(pack.version ? { version: pack.version } : {}),
    }));
  const normalizedBuiltInPacks = builtInPacks.map((pack) => {
    const version = normalizeRulePackVersion(pack.version);
    return {
      pack_id: pack.pack_id,
      display_name: pack.display_name,
      ...(version ? { version, rule_set: `${pack.pack_id}@${version}` } : {}),
    };
  });
  const seenPackIds = new Set(normalizedBuiltInPacks.map((pack) => pack.pack_id));
  const casePacks = Array.from(
    new Set((state.caseRuleDefinitions ?? []).map((definition) => definition.pack_id)),
  )
    .filter((packId) => !seenPackIds.has(packId))
    .map((packId) => ({
      pack_id: packId,
      display_name: formatCaseRulePackDisplayName(packId, state.caseInput.caseId),
    }));

  return [...normalizedBuiltInPacks, ...casePacks];
}

/** 为规则审计结果补齐规则摘要，并挂载 official linter 命中位置。 */
export function enrichRuleAuditResultsWithSummary(
  state: ScoreGraphState,
  ruleAuditResults: RuleAuditResult[],
): RuleAuditResult[] {
  const ruleSummaryById = new Map(
    listRegisteredRules(state.caseRuleDefinitions ?? []).map((rule) => [
      rule.rule_id,
      rule.summary,
    ]),
  );

  const findingsByRuleResultId = new Map<string, OfficialLinterFinding[]>();
  for (const finding of state.officialLinterFindings ?? []) {
    const ruleResultId = `OFFICIAL-LINTER:${finding.rule_id}`;
    findingsByRuleResultId.set(ruleResultId, [
      ...(findingsByRuleResultId.get(ruleResultId) ?? []),
      finding,
    ]);
  }

  return ruleAuditResults.map((rule) => {
    const findings = findingsByRuleResultId.get(rule.rule_id) ?? [];
    return {
      rule_id: rule.rule_id,
      rule_summary: rule.rule_summary ?? ruleSummaryById.get(rule.rule_id) ?? "",
      rule_source: rule.rule_source,
      result: rule.result,
      conclusion: rule.conclusion,
      ...(findings.length > 0
        ? {
            finding_count: findings.length,
            findings: findings.map((finding) => ({
              file: finding.file,
              line: finding.line,
              column: finding.column,
              severity: finding.severity,
              message: finding.message,
            })),
          }
        : {}),
    };
  });
}

const severityRank: Record<OfficialLinterFinding["severity"], number> = {
  error: 4,
  warn: 3,
  suggestion: 2,
  unknown: 1,
};

function roundScoreDelta(value: number): number {
  return Math.round(value * 100) / 100;
}

function pickHighestSeverity(findings: OfficialLinterFinding[]): OfficialLinterFinding["severity"] {
  return findings.reduce<OfficialLinterFinding["severity"]>((highest, finding) => {
    return severityRank[finding.severity] > severityRank[highest] ? finding.severity : highest;
  }, "unknown");
}

type OfficialScoreImpact = {
  dimension_name: string;
  item_name: string;
  score_delta: number;
  reason: string;
};

function collectOfficialFindingsByRule(state: ScoreGraphState) {
  const findingsByRule = new Map<string, OfficialLinterFinding[]>();
  for (const finding of state.officialLinterFindings ?? []) {
    findingsByRule.set(finding.rule_id, [...(findingsByRule.get(finding.rule_id) ?? []), finding]);
  }
  return findingsByRule;
}

function collectOfficialScoreImpacts(state: ScoreGraphState) {
  const scoreImpactsByRuleId = new Map<string, OfficialScoreImpact[]>();
  for (const detail of state.scoreComputation.scoreFusionDetails ?? []) {
    for (const impact of detail.rule_impacts) {
      if (!impact.rule_id.startsWith("OFFICIAL-LINTER:")) {
        continue;
      }
      scoreImpactsByRuleId.set(impact.rule_id, [
        ...(scoreImpactsByRuleId.get(impact.rule_id) ?? []),
        {
          dimension_name: detail.dimension_name,
          item_name: detail.item_name,
          score_delta: impact.score_delta,
          reason: impact.rule_id,
        },
      ]);
    }
  }
  return scoreImpactsByRuleId;
}

function buildOfficialLinterRuleResult(input: {
  ruleId: string;
  findings: OfficialLinterFinding[];
  affectedItems: OfficialScoreImpact[];
  conclusion?: string;
}): Record<string, unknown> {
  const ruleResultId = `OFFICIAL-LINTER:${input.ruleId}`;
  return {
    rule_id: input.ruleId,
    rule_result_id: ruleResultId,
    source_rule_set: input.findings[0]?.source_rule_set ?? "unknown",
    severity: pickHighestSeverity(input.findings),
    result: "不满足",
    finding_count: input.findings.length,
    findings: input.findings.map((finding) => ({
      file: finding.file,
      line: finding.line,
      column: finding.column,
      severity: finding.severity,
      message: finding.message,
    })),
    conclusion:
      input.conclusion ?? `官方 Code Linter ${input.ruleId} 命中 ${input.findings.length} 处。`,
    score_delta: roundScoreDelta(
      input.affectedItems.reduce((sum, item) => sum + item.score_delta, 0),
    ),
    affected_items: input.affectedItems,
  };
}

/** 将 official Code Linter 原始 findings 转换为报告中的规则结果视图。 */
export function buildOfficialLinterResults(state: ScoreGraphState): Array<Record<string, unknown>> {
  const findingsByRule = collectOfficialFindingsByRule(state);
  const scoreImpactsByRuleId = collectOfficialScoreImpacts(state);
  const ruleResultsById = new Map(
    (state.officialLinterRuleResults ?? []).map((result) => [result.rule_id, result]),
  );
  return Array.from(findingsByRule.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ruleId, findings]) => {
      const ruleResultId = `OFFICIAL-LINTER:${ruleId}`;
      return buildOfficialLinterRuleResult({
        ruleId,
        findings,
        affectedItems: scoreImpactsByRuleId.get(ruleResultId) ?? [],
        conclusion: ruleResultsById.get(ruleResultId)?.conclusion,
      });
    });
}

export function buildHvigorBuildCheckSummary(
  summary: HvigorBuildCheckSummary | undefined,
): Record<string, unknown> | undefined {
  if (!summary) {
    return undefined;
  }
  const output: Record<string, unknown> = {
    enabled: summary.enabled,
    status: summary.status,
    checked_modules: summary.checkedModules,
    hard_gate_triggered: summary.hardGateTriggered,
    duration_ms: summary.durationMs,
    module_results: summary.moduleResults.map((result) => {
      const moduleResult: Record<string, unknown> = {
        module_path: result.modulePath,
        module_name: result.moduleName,
        command: result.command,
        status: result.status,
        duration_ms: result.durationMs,
      };
      if (result.exitCode !== undefined) {
        moduleResult.exit_code = result.exitCode;
      }
      if (result.diagnostics !== undefined) {
        moduleResult.diagnostics = result.diagnostics;
      }
      return moduleResult;
    }),
  };
  if (summary.hvigorRunDir !== undefined) {
    output.hvigor_run_dir = summary.hvigorRunDir;
  }
  if (summary.buildCheckSource !== undefined) {
    output.build_check_source = summary.buildCheckSource;
  }
  if (summary.scoreCap !== undefined) {
    output.score_cap = summary.scoreCap;
  }
  if (summary.diagnostics !== undefined) {
    output.diagnostics = summary.diagnostics;
  }
  return {
    ...output,
  };
}

export function buildOverallConclusion(state: ScoreGraphState): Record<string, unknown> {
  const overall = state.scoreComputation.overallConclusion as Record<string, unknown>;
  const totalScore =
    typeof overall.total_score === "number"
      ? overall.total_score
      : state.scoreComputation.totalScore;
  return {
    ...overall,
    total_score: totalScore,
    pre_cap_score: typeof overall.pre_cap_score === "number" ? overall.pre_cap_score : totalScore,
    hard_gate_triggered:
      typeof overall.hard_gate_triggered === "boolean"
        ? overall.hard_gate_triggered
        : state.scoreComputation.hardGateTriggered,
    hard_gates: Array.isArray(overall.hard_gates) ? overall.hard_gates : [],
    summary: typeof overall.summary === "string" ? overall.summary : "",
  };
}

export function buildCaseRuleResults(state: ScoreGraphState, ruleAuditResults: RuleAuditResult[]) {
  return (state.caseRuleDefinitions ?? []).map((definition) => {
    const matchedRule = ruleAuditResults.find((rule) => rule.rule_id === definition.rule_id);
    return {
      rule_id: definition.rule_id,
      rule_name: definition.rule_name,
      priority: definition.priority,
      rule_source: definition.rule_source,
      result: matchedRule?.result ?? "待人工复核",
      conclusion: matchedRule?.conclusion ?? "缺少最终规则判定结果。",
      hard_gate_triggered: definition.priority === "P0" && matchedRule?.result === "不满足",
    };
  });
}

function resolveEffectiveRuleAuditResults(state: ScoreGraphState): RuleAuditResult[] {
  return (state.mergedRuleAuditResults?.length ?? 0) > 0
    ? state.mergedRuleAuditResults
    : (state.deterministicRuleResults ?? []);
}

function buildBasicInfo(state: ScoreGraphState): Record<string, unknown> {
  return {
    rubric_version: "v1",
    task_type: state.taskType,
    evaluation_mode: "auto_precheck_with_human_review",
    rules_enabled: true,
    build_check_enabled: state.hvigorBuildCheckSummary?.enabled ?? false,
    target_description: "HarmonyOS 生成工程评分",
    target_scope: state.caseInput.generatedProjectPath,
    task_type_basis: (state.taskUnderstanding?.classificationHints ?? []).join("; "),
  };
}

function buildScorePolicy(): Record<string, unknown> {
  return {
    risk_level_weights: {
      high: 1,
      medium: 0.6,
      low: 0.3,
      none: 0,
    },
  };
}

function buildDefaultOfficialLinterSummary() {
  return {
    configuredRuleSets: [...officialCodeLinterRecommendedRuleSets],
    effectiveFindingCount: 0,
    runStatus: "not_installed",
    durationMs: 0,
  };
}

function buildReportMeta(state: ScoreGraphState): Record<string, unknown> {
  return {
    result_json_file_name: "result.json",
    unit_name: state.caseInput.caseId,
    generated_at: new Date().toISOString(),
  };
}

/** 汇总 result.json 主体，index 节点只负责读取 schema 与校验。 */
export function buildReportResultJson(state: ScoreGraphState): Record<string, unknown> {
  const effectiveRuleAuditResults = resolveEffectiveRuleAuditResults(state);
  const resultJson: Record<string, unknown> = {
    schema_version: "result.v2",
    basic_info: buildBasicInfo(state),
    overall_conclusion: buildOverallConclusion(state),
    score_policy: buildScorePolicy(),
    dimension_results: buildDimensionResults(state),
    bound_rule_packs: buildBoundRulePacks(state),
    risks: state.scoreComputation.risks,
    strengths: state.scoreComputation.strengths,
    main_issues: state.scoreComputation.mainIssues,
    human_review_items: state.scoreComputation.humanReviewItems,
    final_recommendation: state.scoreComputation.finalRecommendation,
    rule_audit_results: enrichRuleAuditResultsWithSummary(state, effectiveRuleAuditResults),
    official_linter_summary: state.officialLinterSummary ?? buildDefaultOfficialLinterSummary(),
    case_rule_results: buildCaseRuleResults(state, effectiveRuleAuditResults),
    report_meta: buildReportMeta(state),
  };
  const buildCheckSummary = buildHvigorBuildCheckSummary(state.hvigorBuildCheckSummary);
  if (buildCheckSummary) {
    resultJson.build_check_summary = buildCheckSummary;
  }

  return resultJson;
}

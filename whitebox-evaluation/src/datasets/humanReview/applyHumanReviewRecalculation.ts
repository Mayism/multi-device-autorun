import type {
  HumanReviewItemReview,
  HumanReviewSubmissionPayload,
  HumanRiskLevel,
} from "./humanReviewTypes.js";

type RecalculationSummary = {
  scoreRecalculationApplied: boolean;
  originalTotalScore: number;
  revisedTotalScore: number;
  changedItemScoreCount: number;
  changedDimensionScoreCount: number;
};

export type HumanReviewRecalculationResult = {
  resultJson: Record<string, unknown>;
  summary: RecalculationSummary;
};

export type HumanReviewRecalculationError = {
  status: 400 | 409;
  message: string;
};

type RuleImpact = Record<string, unknown> & {
  rule_id?: unknown;
  score_delta?: unknown;
  needs_human_review?: unknown;
};

type ItemResult = Record<string, unknown> & {
  item_name?: unknown;
  score?: unknown;
  agent_evaluation?: unknown;
  rule_impacts?: unknown;
  score_fusion?: unknown;
  score_recalculation?: unknown;
};

type DimensionResult = Record<string, unknown> & {
  dimension_name?: unknown;
  score?: unknown;
  item_results?: unknown;
  rule_violation_summary?: unknown;
};

const RISK_LEVELS = new Set(["high", "medium", "low", "none"]);
export function applyHumanReviewRecalculation(input: {
  resultJson: Record<string, unknown>;
  payload: HumanReviewSubmissionPayload;
  reviewedAt: string;
}): HumanReviewRecalculationResult | HumanReviewRecalculationError {
  const resultJson = cloneJson(input.resultJson);
  const originalTotalScore = readTotalScore(resultJson);
  if (originalTotalScore === undefined) {
    return { status: 409, message: "overall_conclusion.total_score is required for recalculation" };
  }
  const originalHardGateTriggered = readHardGateTriggered(resultJson);
  const activeGateCaps = collectInitialGateCaps(resultJson, {
    originalHardGateTriggered,
    originalTotalScore,
  });
  const touchedRuleIds = new Set<string>();
  let applied = false;
  let changedRiskCount = 0;
  const changedItemReviewCount = 0;

  const itemReviews = input.payload.itemReviews ?? [];
  const itemReviewEffects: Array<Record<string, unknown>> = [];
  for (const review of itemReviews) {
    itemReviewEffects.push({
      itemId: review.itemId,
      agree: review.agree,
      reason: review.reason,
      score_effect_applied: false,
    });
  }

  const riskReviewEffects: Array<Record<string, unknown>> = [];
  for (const review of input.payload.riskReviews ?? []) {
    const risk = findArrayItemById(resultJson.risks, review.riskId);
    const effect = asRecord(risk?.score_effect);
    let effectApplied = false;
    if (!review.agree && risk) {
      risk.level = review.correctedLevel;
      changedRiskCount += 1;
      if (effect?.type === "risk_level_rule_impact") {
        const ruleId = readString(effect.rule_id);
        if (ruleId) {
          if (touchedRuleIds.has(ruleId)) {
            return { status: 400, message: `rule_id ${ruleId} is reviewed more than once` };
          }
          touchedRuleIds.add(ruleId);
        }
        applyRiskLevelEffect(resultJson, review.correctedLevel, effect, activeGateCaps);
        effectApplied = true;
      }
    }
    if (effectApplied) {
      applied = true;
    }
    riskReviewEffects.push({
      riskId: review.riskId,
      agree: review.agree,
      correctedLevel: review.correctedLevel,
      reason: review.reason,
      score_effect_applied: effectApplied,
    });
  }

  for (const [index, review] of itemReviews.entries()) {
    const effectApplied = applyAgreedHardGateReview(resultJson, review, activeGateCaps);
    if (effectApplied) {
      itemReviewEffects[index] = {
        ...itemReviewEffects[index],
        score_effect_applied: true,
      };
      applied = true;
    }
  }

  const recalc = recalculateScores(resultJson, activeGateCaps);
  const revisedTotalScore = recalc.revisedTotalScore ?? originalTotalScore;
  const overall = ensureRecord(resultJson, "overall_conclusion");
  overall.total_score = revisedTotalScore;
  overall.hard_gate_triggered = activeGateCaps.size > 0;
  if (
    applied ||
    revisedTotalScore !== originalTotalScore ||
    originalHardGateTriggered !== activeGateCaps.size > 0
  ) {
    overall.summary = `已根据人工逐条复核重新计分：${formatScore(originalTotalScore)} -> ${formatScore(revisedTotalScore)}。`;
  }

  resultJson.human_review_revision = {
    applied: true,
    reviewed_at: input.reviewedAt,
    reviewer: sanitizeReviewer(input.payload.reviewer),
    overall_comment: sanitizeOverallComment(input.payload.overallComment),
    score_recalculation: {
      original_total_score: originalTotalScore,
      revised_total_score: revisedTotalScore,
      original_hard_gate_triggered: originalHardGateTriggered,
      revised_hard_gate_triggered: activeGateCaps.size > 0,
      changed_item_count: changedItemReviewCount,
      changed_risk_count: changedRiskCount,
    },
    item_reviews: itemReviewEffects,
    risk_reviews: riskReviewEffects,
  };

  return {
    resultJson,
    summary: {
      scoreRecalculationApplied:
        applied ||
        revisedTotalScore !== originalTotalScore ||
        originalHardGateTriggered !== activeGateCaps.size > 0,
      originalTotalScore,
      revisedTotalScore,
      changedItemScoreCount: recalc.changedItemScoreCount,
      changedDimensionScoreCount: recalc.changedDimensionScoreCount,
    },
  };
}

function cloneJson(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function applyRiskLevelEffect(
  resultJson: Record<string, unknown>,
  correctedLevel: HumanRiskLevel | undefined,
  effect: Record<string, unknown>,
  activeGateCaps: Map<string, number>,
): void {
  if (!correctedLevel || !RISK_LEVELS.has(correctedLevel)) {
    return;
  }
  const ruleId = readString(effect.rule_id);
  const originalLevel = readString(effect.original_level);
  const scorePolicy = asRecord(resultJson.score_policy);
  const levelWeights = asRecord(effect.level_weights) ?? asRecord(scorePolicy?.risk_level_weights);
  const originalWeight = readNumber(levelWeights?.[originalLevel ?? ""]);
  const correctedWeight = readNumber(levelWeights?.[correctedLevel]);
  if (
    !ruleId ||
    originalWeight === undefined ||
    originalWeight === 0 ||
    correctedWeight === undefined
  ) {
    return;
  }
  const impacts = Array.isArray(effect.impacts) ? effect.impacts : [];
  for (const impactEffect of impacts) {
    const impactRecord = asRecord(impactEffect);
    const dimensionName = readString(impactRecord?.dimension_name);
    const itemName = readString(impactRecord?.item_name);
    const originalDelta = readNumber(impactRecord?.original_score_delta);
    if (!dimensionName || !itemName || originalDelta === undefined) {
      continue;
    }
    const correctedDelta = roundScore((originalDelta / originalWeight) * correctedWeight);
    const ruleImpact = findRuleImpact(resultJson, { ruleId, dimensionName, itemName });
    if (ruleImpact) {
      ruleImpact.score_delta = correctedDelta;
    }
  }
  const activeLevels = readStringArray(effect.hard_gate_active_levels);
  const shouldActivateGate =
    activeLevels.length === 0 ? correctedLevel === "high" : activeLevels.includes(correctedLevel);
  const gateIds = readStringArray(effect.hard_gate_ids);
  if (shouldActivateGate) {
    addGates(gateIds, asRecord(effect.gate_caps), activeGateCaps);
  } else {
    removeGates(gateIds, activeGateCaps);
  }
}

function applyAgreedHardGateReview(
  resultJson: Record<string, unknown>,
  review: HumanReviewItemReview,
  activeGateCaps: Map<string, number>,
): boolean {
  if (!review.agree) {
    return false;
  }
  const item = findArrayItemById(resultJson.human_review_items, review.itemId);
  const effect = asRecord(item?.score_effect);
  if (effect?.type !== "hard_gate") {
    return false;
  }
  const currentAssessment = readString(item?.current_assessment);
  const gateIds =
    currentAssessment === undefined
      ? readStringArray(effect.gate_ids)
      : parseHardGateAssessment(currentAssessment);
  return addGates(gateIds, asRecord(effect.gate_caps), activeGateCaps);
}

function recalculateScores(
  resultJson: Record<string, unknown>,
  activeGateCaps: Map<string, number>,
): {
  revisedTotalScore?: number;
  changedItemScoreCount: number;
  changedDimensionScoreCount: number;
} {
  let changedItemScoreCount = 0;
  let changedDimensionScoreCount = 0;
  const dimensions = readDimensions(resultJson);
  if (dimensions.length === 0) {
    return { changedItemScoreCount, changedDimensionScoreCount };
  }
  for (const dimension of dimensions) {
    let dimensionScore = 0;
    for (const item of readItems(dimension)) {
      const previousScore = readNumber(item.score) ?? 0;
      const baseScore = readNumber(asRecord(item.agent_evaluation)?.base_score) ?? previousScore;
      const ruleImpacts = readRuleImpacts(item);
      const ruleDelta = roundScore(
        ruleImpacts.reduce((sum, impact) => sum + (readNumber(impact.score_delta) ?? 0), 0),
      );
      const rawScore = roundScore(Math.max(0, baseScore + ruleDelta));
      const nextScore = snapScoreToBands(rawScore, readScoringBands(item));
      item.score = nextScore;
      const scoreFusion = ensureRecord(item, "score_fusion");
      scoreFusion.rule_delta = ruleDelta;
      scoreFusion.final_score = nextScore;
      scoreFusion.fusion_logic =
        ruleDelta === 0
          ? "人工复核后未保留规则扣分，最终分等于基础分。"
          : `人工复核后基础分 ${formatScore(baseScore)}，规则修正 ${formatScore(ruleDelta)}，最终 ${formatScore(nextScore)}。`;
      if (nextScore !== previousScore) {
        changedItemScoreCount += 1;
      }
      dimensionScore = roundScore(dimensionScore + nextScore);
    }
    const previousDimensionScore = readNumber(dimension.score) ?? 0;
    dimension.score = dimensionScore;
    const summary = asRecord(dimension.rule_violation_summary);
    if (summary) {
      const totalRuleDelta = readItems(dimension).reduce(
        (sum, item) =>
          sum +
          readRuleImpacts(item).reduce(
            (impactSum, impact) => impactSum + (readNumber(impact.score_delta) ?? 0),
            0,
          ),
        0,
      );
      summary.total_rule_delta = roundScore(totalRuleDelta);
    }
    if (dimensionScore !== previousDimensionScore) {
      changedDimensionScoreCount += 1;
    }
  }

  const rawTotalScore = roundScore(
    dimensions.reduce((sum, dimension) => sum + (readNumber(dimension.score) ?? 0), 0),
  );
  const cap = Array.from(activeGateCaps.values()).reduce<number | undefined>(
    (minCap, current) => (minCap === undefined ? current : Math.min(minCap, current)),
    undefined,
  );
  return {
    revisedTotalScore: cap === undefined ? rawTotalScore : Math.min(rawTotalScore, cap),
    changedItemScoreCount,
    changedDimensionScoreCount,
  };
}

function collectInitialGateCaps(
  resultJson: Record<string, unknown>,
  fallback: { originalHardGateTriggered: boolean; originalTotalScore: number },
): Map<string, number> {
  const active = new Map<string, number>();
  const buildCheckCap = readBuildCheckGateCap(resultJson);
  if (buildCheckCap !== undefined) {
    active.set("BUILD-CHECK", buildCheckCap);
  }
  for (const risk of readRecords(resultJson.risks)) {
    const effect = asRecord(risk.score_effect);
    if (effect?.type !== "risk_level_rule_impact") {
      continue;
    }
    const activeLevels = readStringArray(effect.hard_gate_active_levels);
    const level = readString(risk.level);
    const isActive =
      activeLevels.length === 0 ? level === "high" : Boolean(level && activeLevels.includes(level));
    if (isActive) {
      addGates(readStringArray(effect.hard_gate_ids), asRecord(effect.gate_caps), active);
    }
  }
  for (const item of readRecords(resultJson.human_review_items)) {
    const effect = asRecord(item.score_effect);
    if (effect?.type === "hard_gate") {
      const currentAssessment = readString(item.current_assessment);
      const gateIds =
        currentAssessment === undefined
          ? readStringArray(effect.gate_ids)
          : parseHardGateAssessment(currentAssessment);
      addGates(gateIds, asRecord(effect.gate_caps), active);
    }
  }
  if (active.size === 0 && fallback.originalHardGateTriggered) {
    active.set("legacy-hard-gate", fallback.originalTotalScore);
  }
  return active;
}

function readBuildCheckGateCap(resultJson: Record<string, unknown>): number | undefined {
  const summary = asRecord(resultJson.build_check_summary);
  if (!summary) {
    return undefined;
  }
  const hardGateTriggered =
    summary.hard_gate_triggered === true || summary.hardGateTriggered === true;
  if (!hardGateTriggered) {
    return undefined;
  }
  return readNumber(summary.score_cap) ?? readNumber(summary.scoreCap) ?? 59;
}

function parseHardGateAssessment(value: string | undefined): string[] {
  if (value?.trim() === "none") {
    return [];
  }
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function findRuleImpact(
  resultJson: Record<string, unknown>,
  input: { ruleId: string; dimensionName: string; itemName: string },
): RuleImpact | undefined {
  const dimension = readDimensions(resultJson).find(
    (item) => readString(item.dimension_name) === input.dimensionName,
  );
  const scoreItem = dimension
    ? readItems(dimension).find((item) => readString(item.item_name) === input.itemName)
    : undefined;
  return scoreItem
    ? readRuleImpacts(scoreItem).find((impact) => readString(impact.rule_id) === input.ruleId)
    : undefined;
}

function readDimensions(resultJson: Record<string, unknown>): DimensionResult[] {
  return readRecords(resultJson.dimension_results) as DimensionResult[];
}

function readItems(dimension: DimensionResult): ItemResult[] {
  return readRecords(dimension.item_results) as ItemResult[];
}

function readRuleImpacts(item: ItemResult): RuleImpact[] {
  return readRecords(item.rule_impacts) as RuleImpact[];
}

function readScoringBands(item: ItemResult): number[] {
  const recalculation = asRecord(item.score_recalculation);
  const bands = Array.isArray(recalculation?.scoring_bands) ? recalculation.scoring_bands : [];
  return bands
    .map((band) => readNumber(asRecord(band)?.score))
    .filter((score): score is number => typeof score === "number");
}

function snapScoreToBands(score: number, bands: number[]): number {
  if (bands.length === 0) {
    return roundScore(score);
  }
  return bands.reduce((best, current) => {
    const bestDistance = Math.abs(best - score);
    const currentDistance = Math.abs(current - score);
    if (currentDistance < bestDistance) {
      return current;
    }
    if (currentDistance === bestDistance) {
      return Math.min(best, current);
    }
    return best;
  }, bands[0] ?? score);
}

function readTotalScore(resultJson: Record<string, unknown>): number | undefined {
  return readNumber(asRecord(resultJson.overall_conclusion)?.total_score);
}

function readHardGateTriggered(resultJson: Record<string, unknown>): boolean {
  return asRecord(resultJson.overall_conclusion)?.hard_gate_triggered === true;
}

function findArrayItemById(value: unknown, id: number): Record<string, unknown> | undefined {
  return readRecords(value).find((item, index) => {
    const itemId = Object.hasOwn(item, "id") ? Number(item.id) : index + 1;
    return itemId === id;
  });
}

function readRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
      )
    : [];
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function addGates(
  gateIds: string[],
  gateCaps: Record<string, unknown> | undefined,
  activeGateCaps: Map<string, number>,
): boolean {
  let changed = false;
  for (const gateId of gateIds) {
    const cap = readNumber(gateCaps?.[gateId]);
    if (cap !== undefined) {
      if (activeGateCaps.get(gateId) !== cap) {
        changed = true;
      }
      activeGateCaps.set(gateId, cap);
    }
  }
  return changed;
}

function removeGates(gateIds: string[], activeGateCaps: Map<string, number>): void {
  for (const gateId of gateIds) {
    activeGateCaps.delete(gateId);
  }
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : String(roundScore(value));
}

function sanitizeReviewer(reviewer: HumanReviewSubmissionPayload["reviewer"]): string | undefined {
  if (typeof reviewer !== "string") {
    return undefined;
  }
  const trimmed = reviewer.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeOverallComment(
  overallComment: HumanReviewSubmissionPayload["overallComment"],
): string | undefined {
  if (typeof overallComment !== "string") {
    return undefined;
  }
  const trimmed = overallComment.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

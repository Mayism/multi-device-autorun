import type { HumanManualRating, HumanRatingGapDecision } from "./humanRatingTypes.js";

export function mapAutoScoreToRating(score: number): HumanManualRating {
  if (score === 100) {
    return "L6";
  }
  if (score >= 90) {
    return "L5";
  }
  if (score >= 80) {
    return "L4";
  }
  if (score >= 60) {
    return "L3";
  }
  return "L2";
}

export function decideHumanRatingGap(
  manualRating: HumanManualRating,
  autoScore: number,
): HumanRatingGapDecision {
  const autoRating = mapAutoScoreToRating(autoScore);
  if (manualRating === "L1" && autoScore >= 70) {
    return { autoRating, gapQualified: true, gapRule: "manual=L1 autoScore>=70" };
  }
  if (manualRating === "L2" && autoScore >= 80) {
    return { autoRating, gapQualified: true, gapRule: "manual=L2 autoScore>=80" };
  }
  return { autoRating, gapQualified: false };
}

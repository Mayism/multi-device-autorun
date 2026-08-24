import type { HumanManualRating } from "../humanRating/humanRatingTypes.js";

export type HumanRiskLevel = "high" | "medium" | "low" | "none";

export type HumanReviewItemReview = {
  itemId: number;
  agree: boolean;
  reason?: string;
};

export type HumanRiskReview = {
  riskId: number;
  agree: boolean;
  correctedLevel?: HumanRiskLevel;
  reason?: string;
};

export type HumanReviewSubmissionPayload = {
  reviewer?: string;
  manualLevel: HumanManualRating;
  overallComment?: string;
  itemReviews?: HumanReviewItemReview[];
  riskReviews?: HumanRiskReview[];
};

export type HumanReviewDatasetType =
  | "item_review_calibration"
  | "risk_review_calibration"
  | "human_rating_gap_analysis";

export type HumanReviewDatasetSample = Record<string, unknown> & {
  type: HumanReviewDatasetType;
};

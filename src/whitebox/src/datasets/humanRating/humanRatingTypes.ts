export type HumanManualRating = "L1" | "L2" | "L3" | "L4" | "L5" | "L6";

export type HumanRatingGapDecision = {
  autoRating: HumanManualRating;
  gapQualified: boolean;
  gapRule?: string;
};

export type HumanRatingGapAnalysisConclusion =
  | "human_rating_needs_improvement"
  | "scoring_system_needs_improvement"
  | "both_need_review"
  | "insufficient_evidence";

export type HumanRatingGapAnalysis = {
  primaryConclusion: HumanRatingGapAnalysisConclusion;
  confidence: "high" | "medium" | "low";
  reasonSummary: string;
  humanRatingReview: {
    needsImprovement: boolean;
    reason: string;
  };
  scoringSystemReview: {
    needsImprovement: boolean;
    reason: string;
  };
  evidence: string[];
  recommendedActions: string[];
};

export type HumanRatingRecord = {
  taskId: number;
  testCaseId?: number;
  caseName?: string;
  reviewedAt: string;
  reviewer?: string;
  manualRating: HumanManualRating;
  basis: string;
  autoScore: number;
  autoRating: HumanManualRating;
  gapQualified: boolean;
  gapRule?: string;
};

export type HumanRatingAnalysisRecord = HumanRatingRecord & {
  analysis: HumanRatingGapAnalysis;
};

import type { RemoteTaskRecord, RemoteTaskRecordStatus } from "../../api/remoteTaskRegistry.js";

export type DashboardStatusCategory = "received" | "queued" | "running" | "completed" | "failed";

export type ManualAnalysisStatus = "pending" | "analyzed";

export type DashboardTaskSummary = {
  taskId: number;
  testCaseId?: number;
  name: string;
  status: RemoteTaskRecordStatus;
  statusCategory: DashboardStatusCategory;
  taskType: string;
  score: number | null;
  hardGateTriggered: boolean | null;
  createdAt: string;
  updatedAt: string;
  resultAvailable: boolean;
  resultError?: string;
  error?: string;
  risks: Array<{ level?: string; title?: string }>;
};

export type DashboardTaskNameIndex = Map<number, string>;

export type DashboardTaskRecordWithResult = {
  record: RemoteTaskRecord;
  summary: DashboardTaskSummary;
};

export type HumanRatingGapDashboardItem = {
  taskId: number;
  testCaseId?: number;
  caseName?: string;
  reviewedAt?: string;
  reviewer?: string;
  manualRating?: string;
  manualBasis?: string;
  autoScore?: number;
  autoRating?: string;
  primaryConclusion?: string;
  confidence?: string;
  reasonSummary?: string;
  humanNeedsImprovement?: boolean;
  scoringNeedsImprovement?: boolean;
  recommendedActions?: unknown[];
  manualAnalysisStatus?: ManualAnalysisStatus;
  manualAnalyzedAt?: string;
};

export type HumanRatingGapReadResult = {
  items: HumanRatingGapDashboardItem[];
  skippedRows: number;
};

export type RiskReviewCalibrationDashboardItem = {
  type: "risk_review_calibration";
  taskId: number;
  testCaseId?: number;
  riskId?: number;
  riskIndex?: number;
  evidenceId?: string;
  taskSummary?: string;
  caseName?: string;
  resultRisk?: Record<string, unknown>;
  humanReview?: Record<string, unknown>;
  manualAnalysisStatus?: ManualAnalysisStatus;
  manualAnalyzedAt?: string;
};

export type RiskReviewCalibrationReadResult = {
  items: RiskReviewCalibrationDashboardItem[];
  skippedRows: number;
};

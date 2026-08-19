import type { HumanReviewEvidenceStore } from "../humanReview/humanReviewEvidenceStore.js";
import { humanRatingGapAnalysisNode } from "../../workflow/nodes/humanRatingGapAnalysis/index.js";
import { decideHumanRatingGap } from "./humanRatingGapRules.js";
import {
  writeHumanRatingAnalysis,
  writeHumanRatingRecord,
  writeHumanRatingSkipped,
} from "./humanRatingArtifactStore.js";
import type {
  HumanManualRating,
  HumanRatingAnalysisRecord,
  HumanRatingGapAnalysis,
  HumanRatingRecord,
} from "./humanRatingTypes.js";

export type ManualRatingAnalyzer = (input: {
  caseDir: string;
  manualRatingRecord: HumanRatingRecord;
  resultJson: Record<string, unknown>;
}) => Promise<HumanRatingGapAnalysis>;

export type HumanRatingSubmissionResult =
  | {
      summary: {
        manualLevel: HumanManualRating;
        autoScore: number;
        autoRating: HumanManualRating;
        gapQualified: boolean;
        analysisStatus: "completed" | "skipped";
      };
      message: string;
    }
  | {
      status: 409;
      message: string;
    };

export async function processHumanRatingSubmission(input: {
  store: HumanReviewEvidenceStore;
  taskId: number;
  testCaseId?: number;
  caseDir: string;
  resultJson: Record<string, unknown>;
  reviewedAt: string;
  reviewer?: string;
  manualLevel: HumanManualRating;
  basis: string;
  analyzeGap?: ManualRatingAnalyzer;
  asyncGapAnalysis?: boolean;
}): Promise<HumanRatingSubmissionResult> {
  const autoScore = readAutoScore(input.resultJson);
  if (autoScore === undefined) {
    return {
      status: 409,
      message: "overall_conclusion.total_score is required for manual rating gap analysis",
    };
  }

  const decision = decideHumanRatingGap(input.manualLevel, autoScore);
  const manualRatingRecord: HumanRatingRecord = {
    taskId: input.taskId,
    testCaseId: input.testCaseId,
    caseName: readCaseName(input.resultJson),
    reviewedAt: input.reviewedAt,
    reviewer: input.reviewer,
    manualRating: input.manualLevel,
    basis: input.basis,
    autoScore,
    autoRating: decision.autoRating,
    gapQualified: decision.gapQualified,
    gapRule: decision.gapRule,
  };
  await writeHumanRatingRecord(input.caseDir, manualRatingRecord);

  if (!decision.gapQualified) {
    await writeHumanRatingSkipped(input.caseDir, manualRatingRecord, "未达到差异分析阈值。");
    await input.store.deleteDatasetSamples("human_rating_gap_analysis", { taskId: input.taskId });
    return {
      summary: {
        manualLevel: input.manualLevel,
        autoScore,
        autoRating: decision.autoRating,
        gapQualified: false,
        analysisStatus: "skipped",
      },
      message: "人工评级已接收，未达到差异分析阈值。",
    };
  }

  const runAnalysis = async (): Promise<void> => {
    const analysis = await (input.analyzeGap ?? defaultAnalyzeGap)({
      caseDir: input.caseDir,
      manualRatingRecord,
      resultJson: input.resultJson,
    });
    const analysisRecord: HumanRatingAnalysisRecord = {
      ...manualRatingRecord,
      analysis,
    };
    await writeHumanRatingAnalysis(input.caseDir, analysisRecord);
    await input.store.upsertDatasetSample(
      "human_rating_gap_analysis",
      {
        type: "human_rating_gap_analysis",
        taskId: input.taskId,
        testCaseId: input.testCaseId,
        caseName: manualRatingRecord.caseName,
        reviewedAt: input.reviewedAt,
        reviewer: input.reviewer,
        manualRating: input.manualLevel,
        manualBasis: input.basis,
        autoScore,
        autoRating: decision.autoRating,
        gapRule: decision.gapRule,
        primaryConclusion: analysis.primaryConclusion,
        confidence: analysis.confidence,
        reasonSummary: analysis.reasonSummary,
        humanNeedsImprovement: analysis.humanRatingReview.needsImprovement,
        scoringNeedsImprovement: analysis.scoringSystemReview.needsImprovement,
        recommendedActions: analysis.recommendedActions,
        artifactPath: "human-rating/analysis.json",
      },
      { taskId: input.taskId },
    );
  };

  if (input.asyncGapAnalysis) {
    void runAnalysis().catch((error) => {
      console.error(
        `human_rating_gap_analysis_failed taskId=${String(input.taskId)} testCaseId=${String(input.testCaseId ?? "unknown")} error=${formatError(error)}`,
      );
    });
    return {
      summary: {
        manualLevel: input.manualLevel,
        autoScore,
        autoRating: decision.autoRating,
        gapQualified: true,
        analysisStatus: "completed",
      },
      message: "人工评级已接收，评分差异较大，差异原因分析已转入后台执行。",
    };
  }

  await runAnalysis();

  return {
    summary: {
      manualLevel: input.manualLevel,
      autoScore,
      autoRating: decision.autoRating,
      gapQualified: true,
      analysisStatus: "completed",
    },
    message: "人工评级已接收，评分差异较大，已完成差异原因分析。",
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readAutoScore(resultJson: Record<string, unknown>): number | undefined {
  const overall = asRecord(resultJson.overall_conclusion);
  const score = overall?.total_score;
  return typeof score === "number" && Number.isFinite(score) ? score : undefined;
}

function readCaseName(resultJson: Record<string, unknown>): string | undefined {
  const basicInfo = asRecord(resultJson.basic_info);
  const caseName = basicInfo?.case_name ?? basicInfo?.name;
  return typeof caseName === "string" && caseName.trim().length > 0 ? caseName : undefined;
}

async function defaultAnalyzeGap(input: {
  caseDir: string;
  manualRatingRecord: HumanRatingRecord;
  resultJson: Record<string, unknown>;
}): Promise<HumanRatingGapAnalysis> {
  return humanRatingGapAnalysisNode(input);
}

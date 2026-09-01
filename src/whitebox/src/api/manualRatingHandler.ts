import fs from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import type { HumanReviewEvidenceStore } from "../datasets/humanReview/humanReviewEvidenceStore.js";
import type { RemoteTaskRegistry } from "./remoteTaskRegistry.js";
import { decideHumanRatingGap } from "../datasets/humanRating/humanRatingGapRules.js";
import {
  writeHumanRatingAnalysis,
  writeHumanRatingRecord,
  writeHumanRatingSkipped,
} from "../datasets/humanRating/humanRatingArtifactStore.js";
import type {
  HumanManualRating,
  HumanRatingAnalysisRecord,
  HumanRatingGapAnalysis,
  HumanRatingRecord,
} from "../datasets/humanRating/humanRatingTypes.js";
import { humanRatingGapAnalysisNode } from "../workflow/nodes/humanRatingGapAnalysis/index.js";

export type ManualRatingAnalyzer = (input: {
  caseDir: string;
  manualRatingRecord: HumanRatingRecord;
  resultJson: Record<string, unknown>;
}) => Promise<HumanRatingGapAnalysis>;

export type SubmitManualRatingDeps = {
  registry: RemoteTaskRegistry;
  store: HumanReviewEvidenceStore;
  analyzeGap?: ManualRatingAnalyzer;
};

type ManualRatingSubmissionPayload = {
  reviewer?: string;
  manualRating: HumanManualRating;
  basis: string;
};

const HUMAN_RATINGS = new Set(["L1", "L2", "L3", "L4", "L5", "L6"]);

export function createSubmitManualRatingHandler(deps: SubmitManualRatingDeps) {
  return async (req: Request, res: Response) => {
    const taskId = readRouteTaskId(req);
    if (taskId === undefined) {
      res.status(404).json({ success: false, message: "Remote task not found" });
      return;
    }

    const payload = parseSubmissionPayload(req.body);
    if (typeof payload === "string") {
      res.status(400).json({ success: false, taskId, message: payload });
      return;
    }

    const record = await deps.registry.get(taskId);
    if (!record) {
      res.status(404).json({ success: false, taskId, message: "Remote task not found" });
      return;
    }
    if (record.status !== "completed") {
      res.status(409).json({
        success: false,
        taskId,
        status: record.status,
        message: "Remote task is not completed yet",
      });
      return;
    }
    if (!record.caseDir) {
      res.status(404).json({ success: false, taskId, message: "Result file not found" });
      return;
    }

    let resultJson: Record<string, unknown>;
    try {
      resultJson = JSON.parse(
        await fs.readFile(path.join(record.caseDir, "outputs", "result.json"), "utf-8"),
      ) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(404).json({ success: false, taskId, message: "Result file not found" });
        return;
      }
      throw error;
    }

    const autoScore = readAutoScore(resultJson);
    if (autoScore === undefined) {
      res.status(409).json({
        success: false,
        taskId,
        message: "overall_conclusion.total_score is required for manual rating gap analysis",
      });
      return;
    }

    const decision = decideHumanRatingGap(payload.manualRating, autoScore);
    const reviewedAt = new Date().toISOString();
    const manualRatingRecord: HumanRatingRecord = {
      taskId,
      testCaseId: record.testCaseId,
      caseName: readCaseName(resultJson),
      reviewedAt,
      reviewer: payload.reviewer,
      manualRating: payload.manualRating,
      basis: payload.basis,
      autoScore,
      autoRating: decision.autoRating,
      gapQualified: decision.gapQualified,
      gapRule: decision.gapRule,
    };
    await writeHumanRatingRecord(record.caseDir, manualRatingRecord);

    if (!decision.gapQualified) {
      await writeHumanRatingSkipped(record.caseDir, manualRatingRecord, "未达到差异分析阈值。");
      await deps.store.deleteDatasetSamples("human_rating_gap_analysis", { taskId });
      res.json({
        success: true,
        taskId,
        status: "completed",
        summary: {
          manualRating: payload.manualRating,
          autoScore,
          autoRating: decision.autoRating,
          gapQualified: false,
          analysisStatus: "skipped",
        },
        message: "人工评级已接收，未达到差异分析阈值。",
      });
      return;
    }

    const analysis = await (deps.analyzeGap ?? defaultAnalyzeGap)({
      caseDir: record.caseDir,
      manualRatingRecord,
      resultJson,
    });
    const analysisRecord: HumanRatingAnalysisRecord = {
      ...manualRatingRecord,
      analysis,
    };
    await writeHumanRatingAnalysis(record.caseDir, analysisRecord);
    await deps.store.upsertDatasetSample(
      "human_rating_gap_analysis",
      {
        type: "human_rating_gap_analysis",
        taskId,
        testCaseId: record.testCaseId,
        caseName: manualRatingRecord.caseName,
        reviewedAt,
        reviewer: payload.reviewer,
        manualRating: payload.manualRating,
        manualBasis: payload.basis,
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
      { taskId },
    );

    res.json({
      success: true,
      taskId,
      status: "completed",
      summary: {
        manualRating: payload.manualRating,
        autoScore,
        autoRating: decision.autoRating,
        gapQualified: true,
        analysisStatus: "completed",
      },
      message: "人工评级已接收，评分差异较大，已完成差异原因分析。",
    });
  };
}

function readRouteTaskId(req: Request): number | undefined {
  const taskId = Number(req.params.taskId);
  return Number.isFinite(taskId) ? taskId : undefined;
}

function parseSubmissionPayload(body: unknown): ManualRatingSubmissionPayload | string {
  if (typeof body !== "object" || body === null) {
    return "Request body must be an object";
  }
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.manualRating !== "string" || !HUMAN_RATINGS.has(candidate.manualRating)) {
    return "manualRating must be one of L1, L2, L3, L4, L5, L6";
  }
  if (typeof candidate.basis !== "string") {
    return "basis must be a string";
  }
  if (candidate.basis !== "" && candidate.basis.trim().length === 0) {
    return "basis cannot be blank";
  }
  if (candidate.reviewer !== undefined && typeof candidate.reviewer !== "string") {
    return "reviewer must be a string";
  }
  return {
    reviewer: candidate.reviewer,
    manualRating: candidate.manualRating as HumanManualRating,
    basis: candidate.basis.trim(),
  };
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

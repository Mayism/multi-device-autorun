import fs from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import type { HumanReviewEvidenceStore } from "../datasets/humanReview/humanReviewEvidenceStore.js";
import type {
  HumanReviewItemReview,
  HumanReviewSubmissionPayload,
  HumanRiskLevel,
  HumanRiskReview,
} from "../datasets/humanReview/humanReviewTypes.js";
import { applyHumanReviewRecalculation } from "../datasets/humanReview/applyHumanReviewRecalculation.js";
import type { ManualRatingAnalyzer } from "../datasets/humanRating/humanRatingSubmission.js";
import { processHumanRatingSubmission } from "../datasets/humanRating/humanRatingSubmission.js";
import type { RemoteTaskRegistry } from "./remoteTaskRegistry.js";

export type SubmitHumanReviewDeps = {
  registry: RemoteTaskRegistry;
  store: HumanReviewEvidenceStore;
  analyzeGap?: ManualRatingAnalyzer;
};

type NormalizedResultRisk = {
  id: number;
  level: string;
  title: string;
  description: string;
  evidence: string;
};

type NormalizedResultReviewItem = {
  id: number;
  item: string;
  current_assessment: string;
  uncertainty_reason: string;
  suggested_focus: string;
};

const RISK_LEVELS = new Set(["high", "medium", "low", "none"]);
const MANUAL_LEVELS = new Set(["L1", "L2", "L3", "L4", "L5", "L6"]);
const HUMAN_REVIEW_ROUTE = "POST /score/remote-tasks/:taskId/human-review";

export function createSubmitHumanReviewHandler(deps: SubmitHumanReviewDeps) {
  return async (req: Request, res: Response) => {
    const taskId = readRouteTaskId(req);
    if (taskId === undefined) {
      res.status(404).json({ success: false, message: "Remote task not found" });
      return;
    }

    const payload = parseSubmissionPayload(req.body);
    if (typeof payload === "string") {
      res.status(400).json({ success: false, message: payload });
      return;
    }

    const record = await deps.registry.get(taskId);
    if (!record) {
      res.status(404).json({ success: false, taskId, message: "Remote task not found" });
      return;
    }
    if (record.caseDir) {
      await logHumanReviewApiRequest(record.caseDir, taskId, record.testCaseId, payload);
    }
    if (record.status !== "completed") {
      await sendHumanReviewResponse(res, 409, record.caseDir, taskId, record.testCaseId, {
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
        await sendHumanReviewResponse(res, 404, record.caseDir, taskId, record.testCaseId, {
          success: false,
          taskId,
          message: "Result file not found",
        });
        return;
      }
      throw error;
    }

    const reviewValidation = validateReviewsWithResult(payload, resultJson);
    if (reviewValidation) {
      await sendHumanReviewResponse(
        res,
        reviewValidation.status,
        record.caseDir,
        taskId,
        record.testCaseId,
        {
          success: false,
          taskId,
          message: reviewValidation.message,
        },
      );
      return;
    }

    const hasReviewItems =
      (payload.itemReviews?.length ?? 0) > 0 || (payload.riskReviews?.length ?? 0) > 0;
    let recalculatedResultJson: Record<string, unknown> | undefined;
    let recalculationSummary:
      | {
          scoreRecalculationApplied: boolean;
          originalTotalScore: number;
          revisedTotalScore: number;
          changedItemScoreCount: number;
          changedDimensionScoreCount: number;
        }
      | undefined;
    const reviewedAt = new Date().toISOString();
    if (hasReviewItems) {
      const recalculation = applyHumanReviewRecalculation({
        resultJson,
        payload,
        reviewedAt,
      });
      if ("status" in recalculation) {
        await sendHumanReviewResponse(
          res,
          recalculation.status,
          record.caseDir,
          taskId,
          record.testCaseId,
          {
            success: false,
            taskId,
            message: recalculation.message,
          },
        );
        return;
      }
      recalculatedResultJson = recalculation.resultJson;
      recalculationSummary = recalculation.summary;
    }

    const itemDatasetCount = await appendItemReviewCalibrationSamples({
      store: deps.store,
      taskId,
      testCaseId: record.testCaseId,
      resultJson,
      payload,
    });
    const riskDatasetCount = await appendRiskReviewCalibrationSamples({
      store: deps.store,
      taskId,
      testCaseId: record.testCaseId,
      resultJson,
      payload,
    });
    const ratingResultJson = recalculatedResultJson ?? resultJson;
    if (recalculatedResultJson) {
      await writeResultJsonAtomically(record.caseDir, recalculatedResultJson);
    }
    const manualRating = await processHumanRatingSubmission({
      store: deps.store,
      taskId,
      testCaseId: record.testCaseId,
      caseDir: record.caseDir,
      resultJson: ratingResultJson,
      reviewedAt,
      reviewer: payload.reviewer,
      manualLevel: payload.manualLevel,
      basis: sanitizeOverallComment(payload.overallComment) ?? "",
      analyzeGap: deps.analyzeGap,
      asyncGapAnalysis: true,
    });
    if ("status" in manualRating) {
      await sendHumanReviewResponse(
        res,
        manualRating.status,
        record.caseDir,
        taskId,
        record.testCaseId,
        {
          success: false,
          taskId,
          message: manualRating.message,
        },
      );
      return;
    }
    const itemReviewCount = payload.itemReviews?.length ?? 0;
    const riskReviewCount = payload.riskReviews?.length ?? 0;
    const riskAgreementCount = (payload.riskReviews ?? []).filter((item) => item.agree).length;
    const riskDisagreementCount = riskReviewCount - riskAgreementCount;
    const hasOverallComment = hasNonEmptyString(payload.overallComment);
    const summary = {
      itemReviewCount,
      riskReviewCount,
      riskAgreementCount,
      riskDisagreementCount,
      datasetItemCount: itemDatasetCount + riskDatasetCount,
      hasOverallComment,
      ...manualRating.summary,
      ...(recalculationSummary?.scoreRecalculationApplied ? recalculationSummary : {}),
    };

    await sendHumanReviewResponse(res, 200, record.caseDir, taskId, record.testCaseId, {
      success: true,
      taskId,
      status: "completed",
      summary,
      message: recalculationSummary?.scoreRecalculationApplied
        ? `人工复核结果已接收，结果分数已重新计算。${manualRating.message}`
        : `人工复核结果已接收。${manualRating.message}`,
    });
  };
}

async function sendHumanReviewResponse(
  res: Response,
  status: number,
  caseDir: string | undefined,
  taskId: number,
  testCaseId: number | undefined,
  body: Record<string, unknown>,
): Promise<void> {
  if (caseDir) {
    await logHumanReviewApiResponse(caseDir, status, taskId, testCaseId, body);
  }
  if (status === 200) {
    res.json(body);
    return;
  }
  res.status(status).json(body);
}

async function logHumanReviewApiRequest(
  caseDir: string,
  taskId: number,
  testCaseId: number | undefined,
  payload: HumanReviewSubmissionPayload,
): Promise<void> {
  await appendCaseLog(
    caseDir,
    "INFO",
    [
      "api_request_triggered",
      `route=${HUMAN_REVIEW_ROUTE}`,
      formatHumanReviewLogContext(taskId, testCaseId),
      `reviewer=${formatLogValue(payload.reviewer ?? "unknown")}`,
      `manualLevel=${payload.manualLevel}`,
      `itemReviewCount=${String(payload.itemReviews?.length ?? 0)}`,
      `riskReviewCount=${String(payload.riskReviews?.length ?? 0)}`,
    ].join(" "),
  );
}

async function logHumanReviewApiResponse(
  caseDir: string,
  status: number,
  taskId: number,
  testCaseId: number | undefined,
  body: Record<string, unknown>,
): Promise<void> {
  const level = status >= 500 ? "ERROR" : status >= 400 ? "WARN" : "INFO";
  await appendCaseLog(
    caseDir,
    level,
    [
      "api_response_sent",
      `route=${HUMAN_REVIEW_ROUTE}`,
      formatHumanReviewLogContext(taskId, testCaseId),
      `status=${String(status)}`,
      `success=${String(body.success)}`,
      `message=${formatLogValue(typeof body.message === "string" ? body.message : "none")}`,
    ].join(" "),
  );
}

async function appendCaseLog(
  caseDir: string,
  level: "INFO" | "WARN" | "ERROR",
  message: string,
): Promise<void> {
  const logPath = path.join(caseDir, "logs", "run.log");
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `[${new Date().toISOString()}] [${level}] ${message}\n`, "utf-8");
}

function formatHumanReviewLogContext(taskId: number, testCaseId: number | undefined): string {
  return `taskId=${String(taskId)} testCaseId=${String(testCaseId ?? "unknown")}`;
}

function formatLogValue(value: string): string {
  return value.replace(/\s+/g, "_").slice(0, 200);
}

function readRouteTaskId(req: Request): number | undefined {
  const taskId = Number(req.params.taskId);
  return Number.isFinite(taskId) ? taskId : undefined;
}

async function writeResultJsonAtomically(
  caseDir: string,
  resultJson: Record<string, unknown>,
): Promise<void> {
  const resultPath = path.join(caseDir, "outputs", "result.json");
  const tempPath = path.join(caseDir, "outputs", "result.json.tmp");
  await fs.writeFile(tempPath, `${JSON.stringify(resultJson, null, 2)}\n`);
  await fs.rename(tempPath, resultPath);
}

function parseSubmissionPayload(body: unknown): HumanReviewSubmissionPayload | string {
  if (typeof body !== "object" || body === null) {
    return "Request body must be an object";
  }
  const candidate = body as Partial<HumanReviewSubmissionPayload>;
  if (candidate.reviewer !== undefined && typeof candidate.reviewer !== "string") {
    return "reviewer must be a string";
  }
  if (typeof candidate.manualLevel !== "string" || !MANUAL_LEVELS.has(candidate.manualLevel)) {
    return "manualLevel must be one of L1, L2, L3, L4, L5, L6";
  }
  if (candidate.overallComment !== undefined && typeof candidate.overallComment !== "string") {
    return "overallComment must be a string";
  }
  const itemReviews = candidate.itemReviews ?? [];
  const riskReviews = candidate.riskReviews ?? [];
  if (!Array.isArray(itemReviews)) {
    return "itemReviews must be an array";
  }
  if (!Array.isArray(riskReviews)) {
    return "riskReviews must be an array";
  }

  const itemIds = new Set<number>();
  for (const [index, item] of itemReviews.entries()) {
    if (typeof item !== "object" || item === null) {
      return "itemReviews entries must be objects";
    }
    const itemReview = item as Record<string, unknown>;
    if (!isPositiveInteger(itemReview.itemId)) {
      return `itemReviews[${String(index)}].itemId is required or invalid`;
    }
    if (itemIds.has(itemReview.itemId)) {
      return `itemReviews[${String(index)}].itemId is duplicated`;
    }
    itemIds.add(itemReview.itemId);
    if (typeof itemReview.agree !== "boolean") {
      return `itemReviews[${String(index)}].agree is required or invalid`;
    }
    if (itemReview.agree === false) {
      if (typeof itemReview.reason !== "string" || itemReview.reason.trim().length === 0) {
        return `itemReviews[${String(index)}].reason is required when agree is false`;
      }
    }
  }

  const riskIds = new Set<number>();
  for (const [index, item] of riskReviews.entries()) {
    if (typeof item !== "object" || item === null) {
      return "riskReviews entries must be objects";
    }
    const riskReview = item as Record<string, unknown>;
    if (!isPositiveInteger(riskReview.riskId)) {
      return `riskReviews[${String(index)}].riskId is required or invalid`;
    }
    if (riskIds.has(riskReview.riskId)) {
      return `riskReviews[${String(index)}].riskId is duplicated`;
    }
    riskIds.add(riskReview.riskId);
    if (typeof riskReview.agree !== "boolean") {
      return `riskReviews[${String(index)}].agree is required or invalid`;
    }
    if (riskReview.agree === false) {
      if (!isRiskLevel(riskReview.correctedLevel)) {
        return `riskReviews[${String(index)}].correctedLevel is required when agree is false`;
      }
      if (typeof riskReview.reason !== "string" || riskReview.reason.trim().length === 0) {
        return `riskReviews[${String(index)}].reason is required when agree is false`;
      }
    }
  }

  return {
    reviewer: candidate.reviewer,
    manualLevel: candidate.manualLevel,
    overallComment: candidate.overallComment,
    itemReviews: itemReviews as HumanReviewItemReview[],
    riskReviews: riskReviews as HumanRiskReview[],
  };
}

function validateReviewsWithResult(
  payload: HumanReviewSubmissionPayload,
  resultJson: Record<string, unknown>,
): { status: 400 | 409; message: string } | undefined {
  const resultItemsById = new Map(readResultReviewItems(resultJson).map((item) => [item.id, item]));
  for (const [index, review] of (payload.itemReviews ?? []).entries()) {
    const resultItem = resultItemsById.get(review.itemId);
    if (!resultItem) {
      return {
        status: 400,
        message: `itemReviews[${String(index)}].itemId does not match result human_review_items`,
      };
    }
  }

  const risksById = new Map(readResultRisks(resultJson).map((risk) => [risk.id, risk]));
  for (const [index, review] of (payload.riskReviews ?? []).entries()) {
    const risk = risksById.get(review.riskId);
    if (!risk) {
      return {
        status: 400,
        message: `riskReviews[${String(index)}].riskId does not match result risks`,
      };
    }
  }
  return undefined;
}

async function appendItemReviewCalibrationSamples(input: {
  store: HumanReviewEvidenceStore;
  taskId: number;
  testCaseId?: number;
  resultJson: Record<string, unknown>;
  payload: HumanReviewSubmissionPayload;
}): Promise<number> {
  const resultItemsById = new Map(
    readResultReviewItems(input.resultJson).map((item) => [item.id, item]),
  );
  let count = 0;
  for (const review of input.payload.itemReviews ?? []) {
    const resultReviewItem = resultItemsById.get(review.itemId);
    if (!resultReviewItem) {
      continue;
    }
    await input.store.appendDatasetSample("item_review_calibration", {
      type: "item_review_calibration",
      taskId: input.taskId,
      testCaseId: input.testCaseId,
      itemId: review.itemId,
      taskSummary: buildTaskSummary(input.resultJson),
      resultReviewItem,
      humanReview: {
        agree: review.agree,
        reason: review.reason,
        overallComment: hasNonEmptyString(input.payload.overallComment)
          ? input.payload.overallComment
          : undefined,
      },
    });
    count += 1;
  }
  return count;
}

async function appendRiskReviewCalibrationSamples(input: {
  store: HumanReviewEvidenceStore;
  taskId: number;
  testCaseId?: number;
  resultJson: Record<string, unknown>;
  payload: HumanReviewSubmissionPayload;
}): Promise<number> {
  const risksById = new Map(readResultRisks(input.resultJson).map((risk) => [risk.id, risk]));
  let count = 0;
  for (const review of input.payload.riskReviews ?? []) {
    const risk = risksById.get(review.riskId);
    if (!risk) {
      continue;
    }
    await input.store.appendDatasetSample("risk_review_calibration", {
      type: "risk_review_calibration",
      taskId: input.taskId,
      testCaseId: input.testCaseId,
      riskId: review.riskId,
      taskSummary: buildTaskSummary(input.resultJson),
      resultRisk: risk,
      humanReview: {
        agree: review.agree,
        correctedLevel: review.correctedLevel,
        reason: review.reason,
        overallComment: hasNonEmptyString(input.payload.overallComment)
          ? input.payload.overallComment
          : undefined,
      },
    });
    count += 1;
  }
  return count;
}

function readResultReviewItems(resultJson: Record<string, unknown>): NormalizedResultReviewItem[] {
  if (!Array.isArray(resultJson.human_review_items)) {
    return [];
  }
  return resultJson.human_review_items.flatMap((item, index) => {
    const reviewItem =
      typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    const id = readResultArrayId(reviewItem, index);
    if (!Number.isInteger(id) || id <= 0) {
      return [];
    }
    return [
      {
        id,
        item: readString(reviewItem.item) ?? "",
        current_assessment: readString(reviewItem.current_assessment) ?? "",
        uncertainty_reason: readString(reviewItem.uncertainty_reason) ?? "",
        suggested_focus: readString(reviewItem.suggested_focus) ?? "",
      },
    ];
  });
}

function readResultRisks(resultJson: Record<string, unknown>): NormalizedResultRisk[] {
  if (!Array.isArray(resultJson.risks)) {
    return [];
  }
  return resultJson.risks.flatMap((item, index) => {
    const risk = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    const id = readResultArrayId(risk, index);
    if (!Number.isInteger(id) || id <= 0) {
      return [];
    }
    return [
      {
        id,
        level: readString(risk.level) ?? "",
        title: readString(risk.title) ?? "",
        description: readString(risk.description) ?? "",
        evidence: readString(risk.evidence) ?? "",
      },
    ];
  });
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function readResultArrayId(item: Record<string, unknown>, index: number): number {
  return Object.hasOwn(item, "id") ? Number(item.id) : index + 1;
}

function isRiskLevel(value: unknown): value is HumanRiskLevel {
  return typeof value === "string" && RISK_LEVELS.has(value);
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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

function buildTaskSummary(resultJson: Record<string, unknown>): string {
  return [readCaseId(resultJson), readTaskType(resultJson)]
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .join(" | ");
}

function readCaseId(resultJson: Record<string, unknown>): string | undefined {
  const reportMeta =
    typeof resultJson.report_meta === "object" && resultJson.report_meta !== null
      ? (resultJson.report_meta as Record<string, unknown>)
      : {};
  return typeof reportMeta.unit_name === "string" ? reportMeta.unit_name : undefined;
}

function readTaskType(resultJson: Record<string, unknown>): string | undefined {
  const basicInfo =
    typeof resultJson.basic_info === "object" && resultJson.basic_info !== null
      ? (resultJson.basic_info as Record<string, unknown>)
      : {};
  return typeof basicInfo.task_type === "string" ? basicInfo.task_type : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

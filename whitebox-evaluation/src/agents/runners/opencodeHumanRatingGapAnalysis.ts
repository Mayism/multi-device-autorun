import { z } from "zod";
import { extractFinalJsonObject } from "../../commons/utils/finalJson.js";
import type { OpencodeRunRequest, OpencodeRunResult } from "../opencode/cliRunner.js";
import type { HumanRatingGapAnalysis, HumanRatingRecord } from "../../datasets/humanRating/humanRatingTypes.js";
import { buildOpencodeRequestTag } from "../opencode/requestTag.js";

const confidenceSchema = z.enum(["high", "medium", "low"]);
const conclusionSchema = z.enum([
  "human_rating_needs_improvement",
  "scoring_system_needs_improvement",
  "both_need_review",
  "insufficient_evidence",
]);

const reviewSchema = z
  .object({
    needsImprovement: z.boolean(),
    reason: z.string().min(1),
  })
  .strict();

const humanRatingGapAnalysisSchema = z
  .object({
    primaryConclusion: conclusionSchema,
    confidence: confidenceSchema,
    reasonSummary: z.string().min(1),
    humanRatingReview: reviewSchema,
    scoringSystemReview: reviewSchema,
    evidence: z.array(z.string().min(1)).min(1),
    recommendedActions: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type OpencodeHumanRatingGapAnalysisOutcome =
  | "success"
  | "request_failed"
  | "protocol_error";

const HUMAN_RATING_GAP_ANALYSIS_OUTPUT_FILE =
  "metadata/agent-output/human-rating-gap-analysis.json";

export interface OpencodeHumanRatingGapAnalysisResult {
  outcome: OpencodeHumanRatingGapAnalysisOutcome;
  final_answer?: HumanRatingGapAnalysis;
  final_answer_raw_text?: string;
  raw_events?: string;
  failure_reason?: string;
}

export interface OpencodeHumanRatingGapAnalysisInput {
  sandboxRoot: string;
  manualRatingRecord: HumanRatingRecord;
  resultJson: Record<string, unknown>;
  runPrompt: (request: OpencodeRunRequest) => Promise<OpencodeRunResult>;
  logger?: {
    warn?(message: string): Promise<void> | void;
  };
}

function stringifyForPrompt(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function schemaFailureMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function renderHumanRatingGapAnalysisPrompt(input: {
  sandboxRoot: string;
  manualRatingRecord: HumanRatingRecord;
  resultJson: Record<string, unknown>;
}): string {
  return [
    "你是评分流程中的人工评级差异分析 agent。只能阅读当前 sandbox 目录内的文件，不能修改业务代码，不能运行命令，不能访问网络。",
    "执行任务前必须使用 hmos-human-rating-gap-analysis skill。该 skill 中的职责边界、证据边界、JSON 输出契约和自检清单是本次输出的强制要求。",
    "",
    `Sandbox 根目录: ${input.sandboxRoot}`,
    "任务:",
    "1. 对比 manual_rating_record 中的人工评级依据和 result_json 中的自动评分结果。",
    "2. 判断差异主要应归因为人工评级需要改进、评分系统需要改进、两侧都需复核，或证据不足。",
    "3. 只能基于输入和 sandbox 内证据给出结论，不要重新打分，不要修改原评分结论。",
    "4. evidence 必须引用可复核证据，例如 outputs/result.json 字段、human-rating/manual-rating.json 字段或 intermediate 文件。",
    "",
    "最终输出要求:",
    "- 将最终 JSON object 写入 output_file。",
    "- assistant 最终回复只输出 {\"output_file\":\"metadata/agent-output/human-rating-gap-analysis.json\"}。",
    `output_file: ${HUMAN_RATING_GAP_ANALYSIS_OUTPUT_FILE}`,
    "- 只输出一个 JSON object，不要 Markdown，不要解释文字。",
    "- JSON 顶层只能包含 primaryConclusion、confidence、reasonSummary、humanRatingReview、scoringSystemReview、evidence、recommendedActions。",
    "- evidence 和 recommendedActions 都必须是非空数组。",
    "",
    "manual_rating_record:",
    stringifyForPrompt(input.manualRatingRecord),
    "",
    "result_json:",
    stringifyForPrompt(input.resultJson),
  ].join("\n");
}

function parseHumanRatingGapAnalysisRunResult(
  runResult: OpencodeRunResult,
): OpencodeHumanRatingGapAnalysisResult {
  try {
    const parsedJson = extractFinalJsonObject(runResult.rawText);
    const parsed = humanRatingGapAnalysisSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return {
        outcome: "protocol_error",
        final_answer_raw_text: runResult.rawText,
        raw_events: runResult.rawEvents,
        failure_reason: schemaFailureMessage(parsed.error),
      };
    }
    return {
      outcome: "success",
      final_answer: parsed.data,
      final_answer_raw_text: runResult.rawText,
      raw_events: runResult.rawEvents,
    };
  } catch (error) {
    return {
      outcome: "protocol_error",
      final_answer_raw_text: runResult.rawText,
      raw_events: runResult.rawEvents,
      failure_reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runOpencodeHumanRatingGapAnalysis(
  input: OpencodeHumanRatingGapAnalysisInput,
): Promise<OpencodeHumanRatingGapAnalysisResult> {
  const requestTag = buildOpencodeRequestTag({
    prefix: "human-rating-gap-analysis",
    caseId: String(input.manualRatingRecord.taskId),
    sandboxRoot: input.sandboxRoot,
  });

  try {
    const runResult = await input.runPrompt({
      prompt: renderHumanRatingGapAnalysisPrompt({
        sandboxRoot: input.sandboxRoot,
        manualRatingRecord: input.manualRatingRecord,
        resultJson: input.resultJson,
      }),
      sandboxRoot: input.sandboxRoot,
      requestTag,
      title: requestTag,
      agent: "hmos-human-rating-gap-analysis",
      outputFile: HUMAN_RATING_GAP_ANALYSIS_OUTPUT_FILE,
    });
    return parseHumanRatingGapAnalysisRunResult(runResult);
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : String(error);
    await input.logger?.warn?.(`opencode human rating gap analysis request failed: ${failureReason}`);
    return {
      outcome: "request_failed",
      failure_reason: failureReason,
    };
  }
}

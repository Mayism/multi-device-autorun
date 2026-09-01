import path from "node:path";
import { z } from "zod";
import { extractFinalJsonObject } from "../../commons/utils/finalJson.js";
import type { OpencodeRunRequest, OpencodeRunResult } from "../opencode/cliRunner.js";
import type { LoadedRubricSnapshot, RubricScoringPayload, RubricScoringResult } from "../../types.js";
import { booleanLikeSchema, finiteNumberSchema, snapScoreToAllowedBand } from "../normalization/agentOutputNormalization.js";
import { buildOpencodeRequestTag } from "../opencode/requestTag.js";
import { loadRiskTaxonomy, normalizeRiskItem } from "../../scoring/riskTaxonomy.js";
import type { RiskTaxonomy } from "../../scoring/riskTaxonomy.js";

const confidenceSchema = z.enum(["high", "medium", "low"]);

const deductionTraceSchema = z
  .object({
    code_locations: z.array(z.string().min(1)).min(1),
    impact_scope: z.string().min(1),
    rubric_comparison: z.string().min(1),
    deduction_reason: z.string().min(1),
    improvement_suggestion: z.string(),
  })
  .strip();

const opencodeRubricScoringSchema = z
  .object({
    summary: z
      .object({
        overall_assessment: z.string().min(1),
        overall_confidence: confidenceSchema,
      })
      .strip(),
    item_scores: z.array(
      z
        .object({
          dimension_name: z.string().min(1),
          item_name: z.string().min(1),
          score: finiteNumberSchema,
          max_score: finiteNumberSchema.optional(),
          matched_band_score: finiteNumberSchema.optional(),
          rationale: z.string().min(1),
          evidence_used: z.array(z.string()),
          confidence: confidenceSchema,
          review_required: booleanLikeSchema,
          deduction_trace: deductionTraceSchema.optional(),
        })
        .strip(),
    ),
    hard_gate_candidates: z.array(
      z
        .object({
          gate_id: z.enum(["G1", "G2", "G3", "G4"]),
          triggered: booleanLikeSchema,
          reason: z.string(),
          confidence: confidenceSchema,
        })
        .strip(),
    ),
    risks: z.array(
      z
        .object({
          level: z.string(),
          title: z.string(),
          description: z.string(),
          evidence: z.string(),
          risk_code: z.string().min(1),
          risk_category: z.enum(["low", "medium", "high"]).optional(),
          source_rule_id: z.string().min(1).optional(),
        })
        .strip(),
    ),
    strengths: z.array(z.string()),
    main_issues: z.array(z.string()),
  })
  .strip();

type ParsedRubricScoringResult = z.infer<typeof opencodeRubricScoringSchema>;

export type OpencodeRubricScoringOutcome = "success" | "request_failed" | "protocol_error";

const RUBRIC_SCORING_OUTPUT_FILE = "metadata/agent-output/rubric-scoring.json";
const MAX_RUBRIC_SCORING_RETRIES = 2;

export interface OpencodeRubricScoringResult {
  outcome: OpencodeRubricScoringOutcome;
  final_answer?: RubricScoringResult;
  final_answer_raw_text?: string;
  raw_events?: string;
  failure_reason?: string;
}

export interface OpencodeRubricScoringInput {
  sandboxRoot: string;
  scoringPayload: RubricScoringPayload;
  runPrompt: (request: OpencodeRunRequest) => Promise<OpencodeRunResult>;
  logger?: {
    info?(message: string): Promise<void> | void;
    warn?(message: string): Promise<void> | void;
    error?(message: string): Promise<void> | void;
  };
}

function stringifyForPrompt(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function trimExpectedOutputFromPromptSummary(summary: string): string {
  return summary.replace(/\n{0,2}(?:期望输出|Expected\s+Output)\s*[：:][\s\S]*$/iu, "").trim();
}

function compactRubricSummary(payload: RubricScoringPayload): LoadedRubricSnapshot {
  const { risk_taxonomy: _riskTaxonomy, ...rubricSummary } = payload.rubric_summary;
  return rubricSummary;
}

function compactRubricScoringPayload(payload: RubricScoringPayload): Record<string, unknown> {
  return {
    case_context: {
      ...payload.case_context,
      original_prompt_summary: trimExpectedOutputFromPromptSummary(
        payload.case_context.original_prompt_summary,
      ),
    },
    task_understanding: payload.task_understanding,
    rubric_summary: compactRubricSummary(payload),
    workspace_project_structure: payload.workspace_project_structure,
    workspace_project_structure_note: payload.workspace_project_structure_note,
  };
}

function strictOutputInstructions(): string[] {
  return [
    "强制输出格式:",
    "- 最终答案的第一个非空字符必须是 {。",
    "- 最后一个非空字符必须是 }。",
    "- 不要输出分析过程、评分步骤、说明文字、Markdown、代码块或自然语言前后缀。",
    "- 不要输出自然语言前后缀；不要写“以下是 JSON”。",
    "- 严格遵守 system prompt 中的正确输出格式。",
    "- 输出前必须自检 JSON 语法：所有 { }、[ ] 成对闭合，所有字符串使用双引号，所有数组元素和对象字段之间用逗号分隔。",
    "- item_scores 是数组；每个 item_scores 条目必须先闭合自身对象，再输出下一个条目或闭合 item_scores 数组。",
    "- deduction_trace 是对象；如果输出 deduction_trace，必须先闭合 deduction_trace 对象，再闭合当前 item_scores 条目对象。",
  ];
}

function summarizeRetryFailureReason(reason: string): string {
  if (reason.includes("缺少 assistant 最终文本")) {
    return "缺少 assistant 最终文本";
  }
  if (reason.includes("JSON object")) {
    return "最终输出不是唯一 JSON object";
  }
  return reason.split(/\r?\n/, 1)[0]?.slice(0, 120) || "未知输出格式错误";
}

function retryFailureGuidance(reason: string): string[] {
  const guidance = [
    "协议错误修复清单:",
    `- listed protocol errors: ${summarizeRetryFailureReason(reason)}`,
    "- 只修复 listed protocol errors，禁止重新评分，禁止改变未列出的 item 判断。",
  ];
  if (reason.includes("missing=")) {
    guidance.push("- missing: 只补齐列出的缺失 item，分值必须来自对应 allowed score。无充分证据时保持满分并降低 confidence 或 review_required。");
  }
  if (reason.includes("duplicate=")) {
    guidance.push("- duplicate: 只保留每个 dimension_name + item_name 的一个条目，删除重复条目。");
  }
  if (reason.includes("unexpected=")) {
    guidance.push("- unexpected: 删除不在 rubric item 列表中的未知 item。");
  }
  if (reason.includes("invalid_band=")) {
    guidance.push("- invalid_band: 将 score 改为对应 item 的 allowed score，并设置 matched_band_score 与 score 相同。");
  }
  if (reason.includes("invalid_weight=")) {
    guidance.push("- invalid_weight: 将 max_score 改为对应 item 的 max_score。");
  }
  if (reason.includes("invalid_deduction_trace=")) {
    guidance.push("- invalid_deduction_trace: 只补齐 listed item 的 deduction_trace；rubric_comparison 写清楚评分档位比较即可，例如“未命中更高档，因为...；命中当前档，因为...”。");
  }
  if (reason.includes("Unrecognized key") || reason.includes("Expected") || reason.includes("Invalid input")) {
    guidance.push("- schema_error: 删除未声明字段，补齐缺失字段，并修正字段类型。");
  }
  return guidance;
}

function renderRubricScoringRetryPrompt(input: {
  retryContext: { failureReason: string; rawText: string };
}): string {
  return [
    "你是评分流程中的 rubric 评分 agent。本次是重试，只修正最终 JSON 输出格式。",
    "本次是重试。仍必须使用 hmos-rubric-scoring skill，但只修复 listed protocol errors，不重新评分。",
    "该 skill 中的输出契约和自检清单是本次输出的强制要求。",
    `上一次失败原因: ${summarizeRetryFailureReason(input.retryContext.failureReason)}`,
    "",
    "输入边界（必须遵守）:",
    "- 不要重新读取原始 prompt、rubric 全量说明或大段上下文。",
    "- 不要输出分析过程、评分步骤、Markdown、代码块或自然语言前后缀。",
    "- 不要重新评分，不要修改上一轮评分判断，只修正最终 JSON 的字段、去重、覆盖和格式问题。",
    "- 沿用上一轮对话中的 scoring_payload、rubric item 列表、允许分值和证据边界。",
    ...retryFailureGuidance(input.retryContext.failureReason),
    "- JSON 字符串中的英文双引号必须转义；如果必须引用原文，先改写为不含双引号的中文转述再写入字段。",
    "",
    "任务:",
    "1. 输出一个合法 JSON object。",
    "2. item_scores 必须覆盖上一轮 scoring_payload 中每个 dimension_name + item_name，不能新增、遗漏或重复。",
    "3. 每个 score 必须来自对应 allowed score；matched_band_score 必须与 score 相同；max_score 必须等于该 item 的 max_score。",
    "4. 对扣分项必须提供 deduction_trace。",
    "5. evidence_used 只能填写 sandbox 内文件相对路径，不要带行号；deduction_trace.code_locations 可填写带行号的位置，但必须使用 generated/ 工程文件中的真实行号，禁止使用 patch hunk 行号。",
    "6. risks 必须是 array；其中每一项必须包含 level、title、description、evidence、risk_code 五个 string 字段，可包含 risk_category、source_rule_id。",
    "7. risks[].evidence 如包含行号，必须使用 generated/ 工程文件中的真实行号，禁止使用 patch hunk 行号、旧文件行号或未重新读取确认的记忆行号；无法确认真实行号时只写文件路径和证据摘要，不写行号。",
    "8. risks 必须遵守 hmos-rubric-scoring skill 的风险 reference 规则；risk_code 必须来自 references/risk-taxonomy.yaml 的 score_taxonomy；禁止使用 risk_level、message、reason 等自造字段；如果没有风险，risks 必须输出空数组 []。",
    "9. JSON 字符串中的英文双引号必须转义；如果必须引用原文，先改写为不含双引号的中文转述再写入字段。",
    "",
    "最终输出要求:",
    "- 将最终 JSON object 写入 output_file。",
    "- assistant 最终回复只输出 {\"output_file\":\"metadata/agent-output/rubric-scoring.json\"}。",
    "- 覆盖写入 output_file，不要沿用旧文件内容。",
    `output_file: ${RUBRIC_SCORING_OUTPUT_FILE}`,
    "- 只输出一个 JSON object，不要 Markdown，不要解释文字。",
    "- 只输出 system prompt 正确输出格式中列出的字段。",
    "- JSON 字段必须完全符合 system prompt 中的结构，不能增加额外字段，中文描述应简洁清晰。",
    ...strictOutputInstructions(),
  ].join("\n");
}

function renderRubricScoringPrompt(input: {
  sandboxRoot: string;
  scoringPayload: RubricScoringPayload;
  retryContext?: { failureReason: string; rawText: string };
}): string {
  const payload = input.scoringPayload;
  if (input.retryContext) {
    return renderRubricScoringRetryPrompt({
      retryContext: input.retryContext,
    });
  }
  return [
    "你是评分流程中的 rubric 评分 agent。只能阅读当前 sandbox 目录内的文件，不能修改文件，不能运行命令，不能访问网络。",
    "执行任务前必须使用 hmos-rubric-scoring skill。该 skill 中的输出契约和自检清单是本次输出的强制要求。",
    "",
    `Sandbox 根目录: ${input.sandboxRoot}`,
    "可阅读目录约定:",
    "- generated/: 待评分的生成结果代码。",
    "- original/: 原始工程代码；如果不存在，说明本用例没有提供原始工程。",
    "- patch/: 生成结果相对原始工程的补丁，优先查看 patch/effective.patch。",
    "- metadata/: 用例元数据。",
    "",
    "任务:",
    "1. 按 rubric_summary 中的每个维度和评分项完成评分。",
    "2. 优先阅读 patch/effective.patch，评分范围仅限 patch 代码；根据 patch 中出现的文件路径继续阅读相关 generated/ 或 original/ 上下文，避免大量阅读无关代码。",
    "3. 按 hmos-rubric-scoring skill 的评分契约覆盖 rubric_summary.dimension_summaries 中每一个 item。",
    "4. 输出 risks 前必须读取 hmos-rubric-scoring skill 的 references/risk-taxonomy.yaml，并按其中规则选择、归并和过滤风险；每个风险必须填写 score_taxonomy 中的 risk_code。",
    "5. risks[].evidence 如包含行号，必须先读取对应 generated/ 工程文件并使用真实行号；禁止使用 patch hunk 行号、旧文件行号或未重新读取确认的记忆行号。无法确认真实行号时，只写文件路径和证据摘要，不写行号。",
    "",
    "最终输出要求:",
    "- 将最终 JSON object 写入 output_file。",
    "- assistant 最终回复只输出 {\"output_file\":\"metadata/agent-output/rubric-scoring.json\"}。",
    `output_file: ${RUBRIC_SCORING_OUTPUT_FILE}`,
    "- 不要输出分析过程、说明文字、Markdown、代码块或自然语言前后缀。",
    "- 其余 JSON 结构、枚举、语言和证据要求均以 hmos-rubric-scoring skill 为准。",
    "",
    "scoring_payload:",
    stringifyForPrompt(compactRubricScoringPayload(payload)),
  ].join("\n");
}

function schemaFailureMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function itemKey(dimensionName: string, itemName: string): string {
  return `${dimensionName}::${itemName}`;
}

function hasValidDeductionTrace(item: RubricScoringResult["item_scores"][number]): boolean {
  if (item.score >= item.max_score) {
    return true;
  }
  const trace = item.deduction_trace;
  return Boolean(
    trace &&
      trace.code_locations.length > 0 &&
      trace.rubric_comparison.trim().length > 0 &&
      trace.improvement_suggestion.trim().length > 0,
  );
}

function validateRubricCoverage(
  finalAnswer: RubricScoringResult,
  rubricSnapshot: LoadedRubricSnapshot,
): { ok: boolean; failureReason?: string } {
  const expected = new Map(
    rubricSnapshot.dimension_summaries.flatMap((dimension) =>
      dimension.item_summaries.map(
        (item) =>
          [
            itemKey(dimension.name, item.name),
            { weight: item.weight, scores: new Set(item.scoring_bands.map((band) => band.score)) },
          ] as const,
      ),
    ),
  );
  const expectedKeys = Array.from(expected.keys());
  const seen = new Set<string>();
  const invalidDeductionTrace = new Set<string>();

  for (const item of finalAnswer.item_scores) {
    const key = itemKey(item.dimension_name, item.item_name);
    const expectedItem = expected.get(key);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (!expectedItem) {
      continue;
    }
    if (!hasValidDeductionTrace(item)) {
      invalidDeductionTrace.add(key);
    }
  }

  const missing = expectedKeys.filter((key) => !seen.has(key));
  const parts = [
    missing.length > 0 ? `missing=${missing.join(",")}` : "",
    invalidDeductionTrace.size > 0
      ? `invalid_deduction_trace=${Array.from(invalidDeductionTrace).join(",")}`
      : "",
  ].filter(Boolean);
  return parts.length > 0 ? { ok: false, failureReason: parts.join("; ") } : { ok: true };
}

function rubricSkeleton(rubricSnapshot: LoadedRubricSnapshot): Array<{
  key: string;
  dimensionName: string;
  itemName: string;
  weight: number;
  allowedScores: Set<number>;
}> {
  return rubricSnapshot.dimension_summaries.flatMap((dimension) =>
    dimension.item_summaries.map((item) => ({
      key: itemKey(dimension.name, item.name),
      dimensionName: dimension.name,
      itemName: item.name,
      weight: item.weight,
      allowedScores: new Set(item.scoring_bands.map((band) => band.score)),
    })),
  );
}

function normalizeRubricResult(
  finalAnswer: ParsedRubricScoringResult,
  rubricSnapshot: LoadedRubricSnapshot,
  riskTaxonomy: RiskTaxonomy,
): RubricScoringResult {
  const itemsByKey = new Map<string, ParsedRubricScoringResult["item_scores"][number]>();
  for (const item of finalAnswer.item_scores) {
    const key = itemKey(item.dimension_name, item.item_name);
    if (!itemsByKey.has(key)) {
      itemsByKey.set(key, item);
    }
  }

  const normalizedItems: RubricScoringResult["item_scores"] = [];
  for (const skeletonItem of rubricSkeleton(rubricSnapshot)) {
    const item = itemsByKey.get(skeletonItem.key);
    if (!item) {
      continue;
    }
    const snappedScore = snapScoreToAllowedBand(item.score, skeletonItem.allowedScores);
    normalizedItems.push({
      ...item,
      dimension_name: skeletonItem.dimensionName,
      item_name: skeletonItem.itemName,
      max_score: skeletonItem.weight,
      score: snappedScore,
      matched_band_score: snappedScore,
    });
  }

  return {
    ...finalAnswer,
    item_scores: normalizedItems,
    risks: finalAnswer.risks.map((risk, index) => ({
      ...normalizeRiskItem(
        {
          id: index + 1,
          ...risk,
        },
        riskTaxonomy,
      ),
    })),
  };
}

function parseRubricRunResult(
  runResult: OpencodeRunResult,
  rubricSnapshot: LoadedRubricSnapshot,
  riskTaxonomy: RiskTaxonomy,
): OpencodeRubricScoringResult {
  let parsedJson: Record<string, unknown>;
  try {
    parsedJson = extractFinalJsonObject(runResult.rawText);
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : String(error);
    return {
      outcome: "protocol_error",
      final_answer_raw_text: runResult.rawText,
      raw_events: runResult.rawEvents,
      failure_reason: failureReason,
    };
  }

  const parsed = opencodeRubricScoringSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      outcome: "protocol_error",
      final_answer_raw_text: runResult.rawText,
      raw_events: runResult.rawEvents,
      failure_reason: schemaFailureMessage(parsed.error),
    };
  }

  const finalAnswer = normalizeRubricResult(parsed.data, rubricSnapshot, riskTaxonomy);
  const validation = validateRubricCoverage(finalAnswer, rubricSnapshot);
  if (!validation.ok) {
    return {
      outcome: "protocol_error",
      final_answer_raw_text: runResult.rawText,
      raw_events: runResult.rawEvents,
      failure_reason: validation.failureReason,
    };
  }

  return {
    outcome: "success",
    final_answer: finalAnswer,
    final_answer_raw_text: runResult.rawText,
    raw_events: runResult.rawEvents,
  };
}

export async function runOpencodeRubricScoring(
  input: OpencodeRubricScoringInput,
): Promise<OpencodeRubricScoringResult> {
  const riskTaxonomy = loadRiskTaxonomy(
    path.resolve(process.cwd(), "references", "risks", "risk-taxonomy.yaml"),
  );
  const requestTag = buildOpencodeRequestTag({
    prefix: "rubric-scoring",
    caseId: input.scoringPayload.case_context.case_id,
    sandboxRoot: input.sandboxRoot,
  });

  async function runOnce(
    inputRequestTag: string,
    retryContext?: { failureReason: string; rawText: string },
    continueSessionId?: string,
  ) {
    return input.runPrompt({
      prompt: renderRubricScoringPrompt({
        sandboxRoot: input.sandboxRoot,
        scoringPayload: input.scoringPayload,
        retryContext,
      }),
      sandboxRoot: input.sandboxRoot,
      requestTag: inputRequestTag,
      title: inputRequestTag,
      agent: "hmos-rubric-scoring",
      continueSessionId,
      outputFile: RUBRIC_SCORING_OUTPUT_FILE,
      logger: input.logger?.info
        ? { info: (message) => input.logger?.info?.(message) }
        : undefined,
    });
  }

  let retryContext: { failureReason: string; rawText: string } | undefined;
  let retrySessionId: string | undefined;

  for (let attempt = 0; attempt <= MAX_RUBRIC_SCORING_RETRIES; attempt += 1) {
    const inputRequestTag = attempt === 0 ? requestTag : `${requestTag}-retry-${attempt}`;
    let runResult: OpencodeRunResult;
    try {
      runResult = await runOnce(inputRequestTag, retryContext, attempt > 0 ? retrySessionId : undefined);
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : String(error);
      const phase = attempt === 0 ? "request" : "retry request";
      await input.logger?.warn?.(`opencode rubric scoring ${phase} failed: ${failureReason}`);
      if (attempt >= MAX_RUBRIC_SCORING_RETRIES) {
        return {
          outcome: "request_failed",
          failure_reason: failureReason,
        };
      }
      retryContext = {
        failureReason,
        rawText: retryContext?.rawText ?? "",
      };
      continue;
    }
    retrySessionId ??= runResult.sessionId;

    const parseResult = parseRubricRunResult(
      runResult,
      input.scoringPayload.rubric_summary,
      riskTaxonomy,
    );
    if (parseResult.outcome !== "protocol_error") {
      return parseResult;
    }
    if (attempt >= MAX_RUBRIC_SCORING_RETRIES) {
      return parseResult;
    }
    retryContext = {
      failureReason: parseResult.failure_reason ?? "unknown protocol error",
      rawText: parseResult.final_answer_raw_text ?? "",
    };
  }

  return {
    outcome: "request_failed",
    failure_reason: "rubric scoring retry loop exited unexpectedly",
  };
}

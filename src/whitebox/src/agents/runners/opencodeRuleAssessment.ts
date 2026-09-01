import { z } from "zod";
import { extractFinalJsonObject } from "../../commons/utils/finalJson.js";
import type { OpencodeRunRequest, OpencodeRunResult } from "../opencode/cliRunner.js";
import type {
  AgentAssistedRuleResult,
  AgentBootstrapPayload,
  AgentBootstrapRuleCandidate,
} from "../../types.js";
import { booleanLikeSchema } from "../normalization/agentOutputNormalization.js";
import { buildOpencodeRequestTag } from "../opencode/requestTag.js";

const opencodeRuleAssessmentSchema = z
  .object({
    summary: z
      .object({
        assistant_scope: z.string().min(1),
        overall_confidence: z.enum(["high", "medium", "low"]),
      })
      .strip(),
    rule_assessments: z
      .array(
        z
          .object({
            rule_id: z.string().min(1),
            decision: z.enum(["violation", "pass", "not_applicable", "uncertain"]),
            confidence: z.enum(["high", "medium", "low"]),
            reason: z.string().min(1),
            evidence_used: z.array(z.string()),
            needs_human_review: booleanLikeSchema,
          })
          .strip(),
      ),
  })
  .strip();

export type OpencodeRuleAssessmentOutcome = "success" | "request_failed" | "protocol_error";

export interface OpencodeRuleAssessmentResult {
  outcome: OpencodeRuleAssessmentOutcome;
  final_answer?: AgentAssistedRuleResult;
  final_answer_raw_text?: string;
  raw_events?: string;
  failure_reason?: string;
}

export interface OpencodeRuleAssessmentInput {
  sandboxRoot: string;
  bootstrapPayload: AgentBootstrapPayload;
  runPrompt: (request: OpencodeRunRequest) => Promise<OpencodeRunResult>;
  logger?: {
    info?(message: string): Promise<void> | void;
    warn?(message: string): Promise<void> | void;
    error?(message: string): Promise<void> | void;
  };
}

const RULE_ASSESSMENT_OUTPUT_FILE = "metadata/agent-output/rule-assessment.json";
const MAX_RULE_ASSESSMENT_RETRIES = 2;

function stringifyForPrompt(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function trimExpectedOutputFromPromptSummary(summary: string): string {
  return summary.replace(/\n{0,2}(?:期望输出|Expected\s+Output)\s*[：:][\s\S]*$/iu, "").trim();
}

function compactRuleAssessmentPayload(payload: AgentBootstrapPayload): Record<string, unknown> {
  return {
    case_context: {
      ...payload.case_context,
      original_prompt_summary: trimExpectedOutputFromPromptSummary(
        payload.case_context.original_prompt_summary,
      ),
    },
    task_understanding: payload.task_understanding,
    assisted_rule_candidates: payload.assisted_rule_candidates,
  };
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
    "- 默认保留已有且与候选规则语义相关的 rule 判断。",
    "- 对 missing、schema_error、语义不相关的 rule 判断，必须按 hmos-rule-assessment skill 和 retry_rule_candidates 重新修正。",
    "- 禁止只根据 rule_id 名称猜测结论；需要直接回答对应 rule_name / target_checks[].llm_prompt。",
  ];
  if (reason.includes("missing=")) {
    guidance.push("- missing: 补齐列出的候选 rule_id；若 retry_rule_candidates 提供了规则内容，必须按其规则语义判定，无法确认时 decision=\"uncertain\" 且 needs_human_review=true。");
  }
  if (reason.includes("duplicate=")) {
    guidance.push("- duplicate: 只保留每个 rule_id 的一个判定，删除重复条目。");
  }
  if (reason.includes("unexpected=")) {
    guidance.push("- unexpected: 删除不在候选规则列表中的未知 rule_id。");
  }
  if (reason.includes("Unrecognized key") || reason.includes("Expected") || reason.includes("Invalid input")) {
    guidance.push("- schema_error: 删除未声明字段，补齐缺失字段，并修正字段类型。");
    guidance.push("- 删除未声明字段，例如 extra、message、risk_level 等。");
  }
  return guidance;
}

function parseRuleIdsFromFailureReason(reason: string, key: string): string[] {
  const match = reason.match(new RegExp(`${key}=([^\\s;]+)`));
  if (!match?.[1]) {
    return [];
  }
  return match[1]
    .split(",")
    .map((ruleId) => ruleId.trim())
    .filter((ruleId) => ruleId.length > 0);
}

function pickRetryRuleCandidates(payload: AgentBootstrapPayload, failureReason: string) {
  const referencedRuleIds = new Set([
    ...parseRuleIdsFromFailureReason(failureReason, "missing"),
    ...parseRuleIdsFromFailureReason(failureReason, "duplicate"),
  ]);
  if (referencedRuleIds.size === 0) {
    return [];
  }
  return payload.assisted_rule_candidates.filter((candidate) =>
    referencedRuleIds.has(candidate.rule_id),
  );
}

function compactRuleRetryPayloadForFailure(
  payload: AgentBootstrapPayload,
  failureReason: string,
): Record<string, unknown> {
  const retryRuleCandidates = pickRetryRuleCandidates(payload, failureReason);
  return {
    candidate_rule_ids: payload.assisted_rule_candidates.map((candidate) => candidate.rule_id),
    ...(retryRuleCandidates.length > 0 ? { retry_rule_candidates: retryRuleCandidates } : {}),
    output_file: RULE_ASSESSMENT_OUTPUT_FILE,
  };
}

function hasReusableRuleAssessmentOutput(rawText: string): boolean {
  if (rawText.trim().length === 0) {
    return false;
  }
  try {
    extractFinalJsonObject(rawText);
    return true;
  } catch {
    return false;
  }
}

function renderRuleAssessmentRetryPrompt(input: {
  sandboxRoot: string;
  bootstrapPayload: AgentBootstrapPayload;
  retryContext: { failureReason: string; rawText: string };
}): string {
  const hasReusableOutput = hasReusableRuleAssessmentOutput(input.retryContext.rawText);
  if (!hasReusableOutput) {
    return [
      "你是评分流程中的规则判定 agent。本次是重试，但上一轮没有可复用的有效输出。",
      "本次是重试。仍必须使用 hmos-rule-assessment skill；由于没有上一轮有效 rule_assessments，必须重新阅读 bootstrap_payload 和 patch，重新完成所有候选规则判定。",
      "该 skill 中的输出契约和自检清单是本次输出的强制要求。",
      `上一次失败原因: ${summarizeRetryFailureReason(input.retryContext.failureReason)}`,
      "",
      `Sandbox 根目录: ${input.sandboxRoot}`,
      "可阅读目录约定:",
      "- generated/: 待评分的生成结果代码。",
      "- original/: 原始工程代码；如果不存在，说明本用例没有提供原始工程。",
      "- patch/: 生成结果相对原始工程的补丁，优先查看 patch/effective.patch。",
      "- metadata/: 用例元数据。",
      "",
      "任务:",
      "1. 阅读 bootstrap_payload 中的候选规则和任务理解。",
      "2. 优先阅读 patch/effective.patch，只基于 patch 内可见文件完成每条候选规则的判定；根据 patch 中出现的文件路径继续阅读相关 generated/ 或 original/ 上下文辅助理解。",
      "3. 按 hmos-rule-assessment skill 的判定契约覆盖 assisted_rule_candidates 中每一个 rule_id。",
      "4. 不要根据 rule_id 名称或泛化工程质量描述猜测结论；每条 reason 必须直接回答对应 rule_name / target_checks[].llm_prompt，并引用相关证据路径。",
      "5. 输出前自检 rule_assessments 的 rule_id 集合必须与 assisted_rule_candidates 完全一致，不能漏判、重复或新增。",
      "",
      "最终输出要求:",
      "- 将最终 JSON object 写入 output_file。",
      "- assistant 最终回复只输出 {\"output_file\":\"metadata/agent-output/rule-assessment.json\"}。",
      "- 覆盖写入 output_file，不要沿用旧文件内容。",
      `output_file: ${RULE_ASSESSMENT_OUTPUT_FILE}`,
      "- 严格遵守 system prompt 中的正确输出格式。",
      "- 不要输出分析过程、说明文字、Markdown、代码块或自然语言前后缀。",
      "- JSON 字段必须完全符合 system prompt 中的结构，不能增加额外字段。",
      "- 最终答案的第一个非空字符必须是 {。",
      "- 最后一个非空字符必须是 }。",
      "",
      "bootstrap_payload:",
      stringifyForPrompt(compactRuleAssessmentPayload(input.bootstrapPayload)),
    ].join("\n");
  }
  return [
    "你是评分流程中的规则判定 agent。本次是重试，需要修复 listed protocol errors 并补齐缺失规则。",
    "仍必须使用 hmos-rule-assessment skill。优先复用已有 output_file 中已完成且语义相关的判定；对缺失、格式错误或语义不相关的规则重新修正。",
    "该 skill 中的输出契约和自检清单是本次输出的强制要求。",
    `上一次失败原因: ${summarizeRetryFailureReason(input.retryContext.failureReason)}`,
    "",
    "输入边界（必须遵守）:",
    "- 尽量避免重新读取原始 prompt、rubric 全量内容或大段上下文。",
    "- 不要输出分析过程、Markdown、代码块或自然语言前后缀。",
    ...(hasReusableOutput
      ? ["- 先读取并修改已有 output_file，保留上一轮已完成且与候选规则相关的 rule_assessments。"]
      : []),
    "- 根据 retry_payload.candidate_rule_ids 覆盖所有候选 rule_id。",
    "- retry_payload.retry_rule_candidates 是本次缺失或需修正规则的精简规则内容；这些规则必须按 rule_name / target_checks[].llm_prompt 判定。",
    "- 若 retry_rule_candidates 中的 target 文件不存在或 patch 未涉及，应按 skill 规则判定为 not_applicable 或 uncertain，不要漏掉该 rule_id。",
    ...retryFailureGuidance(input.retryContext.failureReason),
    "- JSON 字符串中的英文双引号必须转义；如果必须引用原文，先改写为不含双引号的中文转述再写入字段。",
    "",
    "任务:",
    hasReusableOutput ? "1. 在已有 output_file 内容基础上输出一个合法 JSON object。" : "1. 输出一个合法 JSON object。",
    "2. rule_assessments 必须覆盖 retry_payload.candidate_rule_ids 中每个 rule_id，不能新增、遗漏或重复。",
    "3. 无法确认时使用 decision=\"uncertain\"，并设置 needs_human_review=true。",
    "4. evidence_used 只能填写 sandbox 相对路径。",
    "5. 输出前逐项核对 candidate_rule_ids，特别是 missing= 中列出的 rule_id。",
    "",
    "最终输出要求:",
    "- 将最终 JSON object 写入 output_file。",
    "- assistant 最终回复只输出 {\"output_file\":\"metadata/agent-output/rule-assessment.json\"}。",
    "- 覆盖写入 output_file，不要沿用旧文件内容。",
    `output_file: ${RULE_ASSESSMENT_OUTPUT_FILE}`,
    "- 严格遵守 system prompt 中的正确输出格式。",
    "- 只输出一个 JSON object，不要 Markdown，不要解释文字。",
    "- JSON 字段必须完全符合 system prompt 中的结构，不能增加额外字段。",
    "- 最终答案的第一个非空字符必须是 {。",
    "- 最后一个非空字符必须是 }。",
    "",
    "retry_payload:",
    stringifyForPrompt(
      compactRuleRetryPayloadForFailure(
        input.bootstrapPayload,
        input.retryContext.failureReason,
      ),
    ),
  ].join("\n");
}

function renderRuleAssessmentPrompt(input: {
  sandboxRoot: string;
  bootstrapPayload: AgentBootstrapPayload;
  retryContext?: { failureReason: string; rawText: string };
}): string {
  const payload = input.bootstrapPayload;
  if (input.retryContext) {
    return renderRuleAssessmentRetryPrompt({
      sandboxRoot: input.sandboxRoot,
      bootstrapPayload: input.bootstrapPayload,
      retryContext: input.retryContext,
    });
  }
  return [
    "你是评分流程中的规则判定 agent。只能阅读当前 sandbox 目录内的文件，不能修改文件，不能运行命令，不能访问网络。",
    "执行任务前必须使用 hmos-rule-assessment skill。该 skill 中的输出契约和自检清单是本次输出的强制要求。",
    "",
    `Sandbox 根目录: ${input.sandboxRoot}`,
    "可阅读目录约定:",
    "- generated/: 待评分的生成结果代码。",
    "- original/: 原始工程代码；如果不存在，说明本用例没有提供原始工程。",
    "- patch/: 生成结果相对原始工程的补丁，优先查看 patch/effective.patch。",
    "- metadata/: 用例元数据。",
    "",
    "任务:",
    "1. 阅读 bootstrap_payload 中的候选规则和任务理解。",
    "2. 优先阅读 patch/effective.patch，只基于 patch 内可见文件完成每条候选规则的判定；根据 patch 中出现的文件路径继续阅读相关 generated/ 或 original/ 上下文辅助理解。",
    "3. 按 hmos-rule-assessment skill 的判定契约覆盖 assisted_rule_candidates 中每一个 rule_id。",
    "4. 输出前自检 rule_assessments 的 rule_id 集合必须与 assisted_rule_candidates 完全一致，不能漏判、重复或新增。",
    "",
    "最终输出要求:",
    "- 将最终 JSON object 写入 output_file。",
    "- assistant 最终回复只输出 {\"output_file\":\"metadata/agent-output/rule-assessment.json\"}。",
    `output_file: ${RULE_ASSESSMENT_OUTPUT_FILE}`,
    "- 不要输出分析过程、说明文字、Markdown、代码块或自然语言前后缀。",
    "- 其余 JSON 结构、枚举、语言和证据要求均以 hmos-rule-assessment skill 为准。",
    "",
    "bootstrap_payload:",
    stringifyForPrompt(compactRuleAssessmentPayload(payload)),
  ].join("\n");
}

function schemaFailureMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function validateRuleCoverage(
  finalAnswer: AgentAssistedRuleResult,
  candidates: AgentBootstrapRuleCandidate[],
): { ok: boolean; failureReason?: string } {
  const expectedRuleIds = candidates.map((candidate) => candidate.rule_id);
  const seen = new Set<string>();

  for (const assessment of finalAnswer.rule_assessments) {
    seen.add(assessment.rule_id);
  }

  const missing = expectedRuleIds.filter((ruleId) => !seen.has(ruleId));
  return missing.length > 0 ? { ok: false, failureReason: `missing=${missing.join(",")}` } : { ok: true };
}

function normalizeRuleAssessmentResult(
  finalAnswer: AgentAssistedRuleResult,
  candidates: AgentBootstrapRuleCandidate[],
): AgentAssistedRuleResult {
  const assessmentsByRuleId = new Map<string, AgentAssistedRuleResult["rule_assessments"][number]>();
  for (const assessment of finalAnswer.rule_assessments) {
    if (!assessmentsByRuleId.has(assessment.rule_id)) {
      assessmentsByRuleId.set(assessment.rule_id, assessment);
    }
  }

  return {
    ...finalAnswer,
    rule_assessments: candidates.map((candidate) => {
      const assessment = assessmentsByRuleId.get(candidate.rule_id);
      if (!assessment) {
        throw new Error(`internal rule coverage validation missed missing=${candidate.rule_id}`);
      }
      return {
        ...assessment,
        rule_id: candidate.rule_id,
      };
    }),
  };
}

function parseRuleAssessmentRunResult(
  runResult: OpencodeRunResult,
  candidates: AgentBootstrapRuleCandidate[],
): OpencodeRuleAssessmentResult {
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

  const parsed = opencodeRuleAssessmentSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      outcome: "protocol_error",
      final_answer_raw_text: runResult.rawText,
      raw_events: runResult.rawEvents,
      failure_reason: schemaFailureMessage(parsed.error),
    };
  }

  const validation = validateRuleCoverage(parsed.data, candidates);
  if (!validation.ok) {
    return {
      outcome: "protocol_error",
      final_answer_raw_text: runResult.rawText,
      raw_events: runResult.rawEvents,
      failure_reason: validation.failureReason,
    };
  }

  const finalAnswer = normalizeRuleAssessmentResult(parsed.data, candidates);
  return {
    outcome: "success",
    final_answer: finalAnswer,
    final_answer_raw_text: runResult.rawText,
    raw_events: runResult.rawEvents,
  };
}

export async function runOpencodeRuleAssessment(
  input: OpencodeRuleAssessmentInput,
): Promise<OpencodeRuleAssessmentResult> {
  const requestTag = buildOpencodeRequestTag({
    prefix: "rule-assessment",
    caseId: input.bootstrapPayload.case_context.case_id,
    sandboxRoot: input.sandboxRoot,
  });
  async function runOnce(
    inputRequestTag: string,
    retryContext?: { failureReason: string; rawText: string },
    continueSessionId?: string,
  ) {
    const preserveOutputFileOnStart =
      retryContext && hasReusableRuleAssessmentOutput(retryContext.rawText) ? true : undefined;
    return input.runPrompt({
      prompt: renderRuleAssessmentPrompt({
        sandboxRoot: input.sandboxRoot,
        bootstrapPayload: input.bootstrapPayload,
        retryContext,
      }),
      sandboxRoot: input.sandboxRoot,
      requestTag: inputRequestTag,
      title: inputRequestTag,
      agent: "hmos-rule-assessment",
      continueSessionId,
      outputFile: RULE_ASSESSMENT_OUTPUT_FILE,
      preserveOutputFileOnStart,
      logger: input.logger?.info
        ? { info: (message) => input.logger?.info?.(message) }
        : undefined,
    });
  }

  let retryContext: { failureReason: string; rawText: string } | undefined;
  let retrySessionId: string | undefined;

  for (let attempt = 0; attempt <= MAX_RULE_ASSESSMENT_RETRIES; attempt += 1) {
    const inputRequestTag = attempt === 0 ? requestTag : `${requestTag}-retry-${attempt}`;
    let runResult: OpencodeRunResult;
    try {
      runResult = await runOnce(inputRequestTag, retryContext, attempt > 0 ? retrySessionId : undefined);
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : String(error);
      const phase = attempt === 0 ? "request" : "retry request";
      await input.logger?.warn?.(`opencode rule assessment ${phase} failed: ${failureReason}`);
      if (attempt >= MAX_RULE_ASSESSMENT_RETRIES) {
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

    const parseResult = parseRuleAssessmentRunResult(
      runResult,
      input.bootstrapPayload.assisted_rule_candidates,
    );
    if (parseResult.outcome !== "protocol_error") {
      return parseResult;
    }
    if (attempt >= MAX_RULE_ASSESSMENT_RETRIES) {
      return parseResult;
    }
    retryContext = {
      failureReason: parseResult.failure_reason ?? "unknown protocol error",
      rawText: parseResult.final_answer_raw_text ?? "",
    };
  }

  return {
    outcome: "request_failed",
    failure_reason: "rule assessment retry loop exited unexpectedly",
  };
}

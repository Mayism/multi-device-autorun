import { extractFinalJsonObject } from "../../commons/utils/finalJson.js";
import type { OpencodeRunRequest, OpencodeRunResult } from "../opencode/cliRunner.js";
import type { ConstraintSummary, TaskUnderstandingAgentInput } from "../../types.js";
import { buildOpencodeRequestTag } from "../opencode/requestTag.js";
import { inferCrossDeviceAdaptation, parseConstraintSummary } from "../normalization/taskUnderstanding.js";

export type OpencodeTaskUnderstandingOutcome = "success" | "request_failed" | "protocol_error";

const TASK_UNDERSTANDING_OUTPUT_FILE = "metadata/agent-output/task-understanding.json";
const MAX_TASK_UNDERSTANDING_RETRIES = 2;

export interface OpencodeTaskUnderstandingResult {
  outcome: OpencodeTaskUnderstandingOutcome;
  summary?: ConstraintSummary;
  raw_text?: string;
  raw_events?: string;
  failure_reason?: string;
}

export interface OpencodeTaskUnderstandingInput {
  sandboxRoot: string;
  agentInput: TaskUnderstandingAgentInput;
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

function uniqueShortList(values: string[], limit: number): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).slice(0, limit);
}

function buildRetryConstraintDraft(input: TaskUnderstandingAgentInput): ConstraintSummary {
  return {
    explicitConstraints: uniqueShortList(
      [
        `固定任务类型: ${input.taskType}`,
        "原始需求: 重试阶段已省略，按首轮预处理摘要输出约束",
      ],
      12,
    ),
    contextualConstraints: uniqueShortList(
      [
        input.projectStructure.modulePaths.length > 0
          ? `模块: ${input.projectStructure.modulePaths.join(", ")}`
          : "模块: 未从工程结构中识别到 HarmonyOS 模块",
        ...input.projectStructure.implementationHints,
      ],
      16,
    ),
    implicitConstraints: input.patchSummary.hasPatch
      ? uniqueShortList(
          [
            `修改范围: ${input.patchSummary.changedFiles.length} 个文件`,
            `影响根目录: ${input.patchSummary.affectedRoots.join(", ") || "未识别"}`,
            `侵入程度: ${input.patchSummary.intrusionLevel}`,
            `改动规模: +${input.patchSummary.addedLines}/-${input.patchSummary.deletedLines}`,
            `改动类型: ${input.patchSummary.changeTypes.join(", ") || "modified"}`,
          ],
          16,
        )
      : ["修改范围: 未提供 patch", "侵入程度: none", "改动类型: 待从生成工程对比确认"],
    classificationHints: uniqueShortList(
      [
        input.taskType,
        input.patchSummary.hasPatch ? "has_patch" : "no_patch",
      ],
      8,
    ),
    crossDeviceAdaptation: inferCrossDeviceAdaptation(input),
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

function renderRetryTaskUnderstandingPrompt(input: {
  sandboxRoot: string;
  agentInput: TaskUnderstandingAgentInput;
  retryContext: { failureReason: string; rawText: string };
}): string {
  const draft = buildRetryConstraintDraft(input.agentInput);
  return [
    "你是评分工作流中的任务理解 agent。任务理解阶段只能读取用户消息指定的 prompt 文件，不能修改既有文件，不能运行命令，不能访问网络。",
    "本次是重试。仍必须使用 hmos-understanding skill。只修正最终输出格式。",
    "该 skill 中的输出契约和自检清单是本次输出的强制要求。",
    "",
    "上一次任务理解输出无效。不要继续分析原始输入，只修正最终输出格式。",
    `上一次失败原因: ${summarizeRetryFailureReason(input.retryContext.failureReason)}`,
    "输入边界（必须遵守）:",
    "- 本次重试禁止读取任何业务文件，禁止调用 glob、grep、list 或任何用于探索工程文件的工具。",
    "- 本次重试不提供原始 input；不要尝试恢复或引用原始需求全文。",
    "- 只根据 constraint_draft 输出最终 JSON。",
    "",
    "任务:",
    "1. 将 constraint_draft 原样整理为合法 JSON object。",
    "2. 顶层只能包含 explicitConstraints、contextualConstraints、implicitConstraints、classificationHints、crossDeviceAdaptation。",
    "3. 前四个字段都必须是中文短句数组，可以包含英文分类标签。",
    "4. crossDeviceAdaptation 必须包含 applicability、confidence、reasons；uncertain 必须使用 low confidence。",
    `5. 固定任务类型: ${input.agentInput.taskType}；不得重新识别、改写或替换该任务类型。`,
    "6. 不要补充分析过程，不要输出 Markdown，不要输出工具调用意图。",
    "7. JSON 字符串中的英文双引号必须转义；如果必须引用原文，先改写为不含双引号的中文转述再写入字段。",
    "",
    "最终输出要求:",
    "- 将最终 JSON object 写入 output_file。",
    "- 严格遵守 system prompt 中的正确输出格式。",
    `- assistant 最终回复只输出 {"output_file":"${TASK_UNDERSTANDING_OUTPUT_FILE}"}。`,
    "覆盖写入 output_file，不要沿用旧文件内容。",
    `output_file: ${TASK_UNDERSTANDING_OUTPUT_FILE}`,
    "",
    "constraint_draft:",
    stringifyForPrompt(draft),
  ].join("\n");
}

function renderTaskUnderstandingPrompt(input: {
  sandboxRoot: string;
  agentInput: TaskUnderstandingAgentInput;
  retryContext?: { failureReason: string; rawText: string };
}): string {
  if (input.retryContext) {
    return renderRetryTaskUnderstandingPrompt({
      sandboxRoot: input.sandboxRoot,
      agentInput: input.agentInput,
      retryContext: input.retryContext,
    });
  }
  return [
    "你是评分工作流中的任务理解 agent。任务理解阶段只能读取用户消息指定的 prompt 文件，不能修改既有文件，不能运行命令，不能访问网络。",
    "执行任务前必须使用 hmos-understanding skill。该 skill 中的输出契约和自检清单是本次输出的强制要求。",
    "",
    `Sandbox 根目录: ${input.sandboxRoot}`,
    "输入边界（必须遵守）:",
    "- 只能基于本 prompt 中的 agent_input 完成任务理解。",
    "- 不要调用 glob、grep、list 或任何用于探索工程文件的工具。",
    "- 不要读取 generated/ 下的任何业务文件。",
    "- 不要读取 original/ 下的任何业务文件。",
    "- 不要读取 patch/ 下的任何业务文件。",
    "- 不要读取 metadata/metadata.json；这些信息已被预处理进 agent_input。",
    "- 不要读取 references/ 下的任何业务文件。",
    "- 如果 agent_input 信息不足，基于 promptText、projectStructure、patchSummary 给出低置信度约束，不要尝试补充读取。",
    "- 首轮和重试都禁止读取任何业务文件。",
    "",
    "任务:",
    "1. agent_input.taskType 是上游固定任务类型，必须直接使用；不得重新识别或改写任务类型。",
    "2. 结合 agent_input 中的 promptText、taskType、工程结构和补丁摘要，提取任务约束摘要。",
    "3. explicitConstraints: 写入固定任务类型、场景、目标和明确要求。",
    "4. contextualConstraints: 从 projectStructure、implementationHints、modulePaths 提取模块、分层、技术栈和实现边界。",
    "5. implicitConstraints: 从 patchSummary 提取修改范围、侵入程度、改动类型和隐含风险。",
    "6. classificationHints: 必须包含 agent_input.taskType，再补充 has_patch/no_patch 等短标签。",
    "7. crossDeviceAdaptation: 判断当前任务是否涉及多设备适配。只有 prompt、工程结构或 patch 摘要明确出现多设备、多端、多屏、跨设备、手机/平板/折叠屏/智慧屏/手表/车机组合、响应式布局、自适应、断点、横竖屏或窗口尺寸变化时，applicability 才能为 involved。",
    "8. 如果只是设备信息、设备权限、HarmonyOS、ArkUI 或普通页面布局，不自动视为多设备适配；信息不足时使用 uncertain 且 confidence 为 low。",
    "9. JSON 字符串中的英文双引号必须转义；如果必须引用原文，先改写为不含双引号的中文转述再写入字段。",
    "",
    "最终输出要求:",
    "- 将最终 JSON object 写入 output_file。",
    "- 严格遵守 system prompt 中的正确输出格式。",
    `- assistant 最终回复只输出 {"output_file":"${TASK_UNDERSTANDING_OUTPUT_FILE}"}。`,
    `output_file: ${TASK_UNDERSTANDING_OUTPUT_FILE}`,
    "",
    "agent_input:",
    stringifyForPrompt(input.agentInput),
  ].join("\n");
}

function parseTaskUnderstandingRunResult(runResult: OpencodeRunResult): OpencodeTaskUnderstandingResult {
  try {
    const parsedJson = extractFinalJsonObject(runResult.rawText);
    const summary = parseConstraintSummary(JSON.stringify(parsedJson));
    return {
      outcome: "success",
      summary,
      raw_text: runResult.rawText,
      raw_events: runResult.rawEvents,
    };
  } catch (error) {
    return {
      outcome: "protocol_error",
      raw_text: runResult.rawText,
      raw_events: runResult.rawEvents,
      failure_reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runOpencodeTaskUnderstanding(
  input: OpencodeTaskUnderstandingInput,
): Promise<OpencodeTaskUnderstandingResult> {
  const requestTag = buildOpencodeRequestTag({
    prefix: "task-understanding",
    caseId: input.agentInput.caseId,
    sandboxRoot: input.sandboxRoot,
  });

  async function runOnce(inputRequestTag: string, retryContext?: { failureReason: string; rawText: string }) {
    return input.runPrompt({
      prompt: renderTaskUnderstandingPrompt({
        sandboxRoot: input.sandboxRoot,
        agentInput: input.agentInput,
        retryContext,
      }),
      sandboxRoot: input.sandboxRoot,
      requestTag: inputRequestTag,
      title: inputRequestTag,
      agent: "hmos-understanding",
      outputFile: TASK_UNDERSTANDING_OUTPUT_FILE,
      logger: input.logger?.info
        ? { info: (message) => input.logger?.info?.(message) }
        : undefined,
    });
  }

  let retryContext: { failureReason: string; rawText: string } | undefined;

  for (let attempt = 0; attempt <= MAX_TASK_UNDERSTANDING_RETRIES; attempt += 1) {
    const inputRequestTag = attempt === 0 ? requestTag : `${requestTag}-retry-${attempt}`;
    let runResult: OpencodeRunResult;
    try {
      runResult = await runOnce(inputRequestTag, retryContext);
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : String(error);
      const phase = attempt === 0 ? "request" : "retry request";
      await input.logger?.warn?.(`opencode task understanding ${phase} failed: ${failureReason}`);
      if (attempt >= MAX_TASK_UNDERSTANDING_RETRIES) {
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

    const parseResult = parseTaskUnderstandingRunResult(runResult);
    if (parseResult.outcome !== "protocol_error") {
      return parseResult;
    }
    if (attempt >= MAX_TASK_UNDERSTANDING_RETRIES) {
      return parseResult;
    }
    retryContext = {
      failureReason: parseResult.failure_reason ?? "unknown protocol error",
      rawText: parseResult.raw_text ?? "",
    };
  }

  return {
    outcome: "request_failed",
    failure_reason: "task understanding retry loop exited unexpectedly",
  };
}

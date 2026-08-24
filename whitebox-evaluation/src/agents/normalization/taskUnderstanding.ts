import { z } from "zod";
import type {
  ConstraintSummary,
  CrossDeviceAdaptationUnderstanding,
  TaskUnderstandingAgentInput,
} from "../../types.js";

const crossDeviceAdaptationSchema = z
  .object({
    applicability: z.enum(["involved", "not_involved", "uncertain"]),
    confidence: z.enum(["high", "medium", "low"]),
    reasons: z.array(z.string().min(1)).min(1).max(5),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.applicability === "uncertain" && value.confidence !== "low") {
      context.addIssue({
        code: "custom",
        message: "crossDeviceAdaptation uncertain requires low confidence",
        path: ["confidence"],
      });
    }
  });

const constraintSummarySchema = z
  .object({
    explicitConstraints: z.array(z.string().min(1)),
    contextualConstraints: z.array(z.string().min(1)),
    implicitConstraints: z.array(z.string().min(1)),
    classificationHints: z.array(z.string().min(1)),
    crossDeviceAdaptation: crossDeviceAdaptationSchema,
  })
  .strict();

function extractJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("Agent 输出不包含 JSON object。");
    }
    return JSON.parse(text.slice(start, end + 1));
  }
}

function normalizeArray(values: string[], limit: number): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).slice(0, limit);
}

export function parseConstraintSummary(rawOutputText: string): ConstraintSummary {
  const parsed = constraintSummarySchema.parse(extractJsonObject(rawOutputText));
  return {
    explicitConstraints: normalizeArray(parsed.explicitConstraints, 12),
    contextualConstraints: normalizeArray(parsed.contextualConstraints, 16),
    implicitConstraints: normalizeArray(parsed.implicitConstraints, 16),
    classificationHints: normalizeArray(parsed.classificationHints, 8),
    crossDeviceAdaptation: {
      applicability: parsed.crossDeviceAdaptation.applicability,
      confidence: parsed.crossDeviceAdaptation.confidence,
      reasons: normalizeArray(parsed.crossDeviceAdaptation.reasons, 5),
    },
  };
}

export function inferCrossDeviceAdaptation(
  input: Pick<TaskUnderstandingAgentInput, "promptText" | "projectStructure" | "patchSummary">,
): CrossDeviceAdaptationUnderstanding {
  const evidenceText = [
    input.promptText,
    ...input.projectStructure.implementationHints,
    ...input.patchSummary.changedFiles,
    ...input.patchSummary.changeTypes,
  ]
    .join("\n")
    .toLowerCase();
  const positiveSignals = [
    /多设备/,
    /多端/,
    /多屏/,
    /跨设备/,
    /跨端/,
    /一多/,
    /手机.*平板|平板.*手机/,
    /折叠屏/,
    /智慧屏/,
    /手表/,
    /车机/,
    /响应式/,
    /自适应/,
    /断点/,
    /横竖屏/,
    /窗口尺寸/,
    /不同设备形态/,
  ];
  if (positiveSignals.some((pattern) => pattern.test(evidenceText))) {
    return {
      applicability: "involved",
      confidence: "medium",
      reasons: ["输入信息出现多设备、多屏或设备形态适配诉求"],
    };
  }
  return {
    applicability: "not_involved",
    confidence: "high",
    reasons: ["需求未出现多设备、多屏或设备形态适配要求"],
  };
}

export function buildFallbackConstraintSummary(
  input: TaskUnderstandingAgentInput,
): ConstraintSummary {
  const explicitConstraints = [
    `固定任务类型: ${input.taskType}`,
    `目标: ${input.promptText.slice(0, 120) || "原始 prompt 未提供明确目标"}`,
  ];

  const contextualConstraints = [
    input.projectStructure.modulePaths.length > 0
      ? `原始模块: ${input.projectStructure.modulePaths.join(", ")}`
      : "原始模块: 未从工程结构中识别到 HarmonyOS 模块",
    ...input.projectStructure.implementationHints,
  ];

  const implicitConstraints = input.patchSummary.hasPatch
    ? [
        `修改范围: ${input.patchSummary.changedFiles.length} 个文件`,
        `侵入程度: ${input.patchSummary.intrusionLevel}`,
        `改动规模: +${input.patchSummary.addedLines}/-${input.patchSummary.deletedLines}`,
        `改动类型: ${input.patchSummary.changeTypes.join(", ") || "modified"}`,
      ]
    : ["修改范围: 未提供 patch", "侵入程度: none", "改动类型: 待从生成工程对比确认"];

  const classificationHints = [
    input.taskType,
    input.patchSummary.hasPatch ? "has_patch" : "no_patch",
  ];

  return {
    explicitConstraints: normalizeArray(explicitConstraints, 12),
    contextualConstraints: normalizeArray(contextualConstraints, 16),
    implicitConstraints: normalizeArray(implicitConstraints, 16),
    classificationHints: normalizeArray(classificationHints, 8),
    crossDeviceAdaptation: inferCrossDeviceAdaptation(input),
  };
}

export function renderTaskUnderstandingPrompt(input: TaskUnderstandingAgentInput): string {
  return [
    "你是评分工作流中的任务理解节点。请从输入中提取约束摘要，只输出 JSON object。",
    "input.taskType 是上游固定任务类型，必须直接使用；不得重新识别或改写任务类型。",
    "必须提取以下五组字段：",
    "explicitConstraints: 写入固定任务类型，并从 prompt 提取行业、场景、目标。",
    "contextualConstraints: 从原始工程结构提取模块、分层、技术栈和实现约束。",
    "implicitConstraints: 从 patch 摘要提取修改范围、侵入程度、改动类型。",
    "classificationHints: 必须包含 input.taskType，再补充 has_patch/no_patch 等短标签。",
    "crossDeviceAdaptation: 判断当前任务是否涉及多设备适配，包含 applicability、confidence、reasons。",
    "多设备适配只在明确涉及多设备、多端、多屏、跨设备、手机/平板/折叠屏/智慧屏/手表/车机组合、响应式布局、自适应、断点、横竖屏或窗口尺寸变化时判定为 involved。",
    "普通设备信息、设备权限、HarmonyOS 或 ArkUI 页面布局本身不自动触发多设备适配。",
    "所有数组元素必须是中文短句，不要输出空字符串。",
    "顶层只能包含 explicitConstraints、contextualConstraints、implicitConstraints、classificationHints、crossDeviceAdaptation。",
    "crossDeviceAdaptation.reasons 最多 5 条；如果 applicability 为 uncertain，confidence 必须为 low。",
    "不要使用 markdown 代码块，不要输出额外解释。",
    "输入：",
    JSON.stringify(input, null, 2),
  ].join("\n");
}

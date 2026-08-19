import { load } from "js-yaml";
import type { RemoteEvaluationTask } from "../../../types.js";

/** 将远端平台的 task 字段组合成本地 case 的 input.txt。 */
export function buildRemotePrompt(task: RemoteEvaluationTask): string {
  return [
    task.testCase.description ? `任务描述：${task.testCase.description}` : "",
    task.testCase.input ? `输入要求：${task.testCase.input}` : "",
    task.testCase.expectedOutput ? `期望输出：${task.testCase.expectedOutput}` : "",
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");
}

/** 判断 expectedOutput 是否是可落盘为用例约束的 YAML/JSON 结构。 */
export function shouldMaterializeExpectedConstraints(expectedOutput: string): boolean {
  const trimmed = expectedOutput.trim();
  if (!trimmed) {
    return false;
  }

  try {
    const parsed = load(trimmed);
    if (Array.isArray(parsed)) {
      return true;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Array.isArray((parsed as { constraints?: unknown }).constraints);
    }
  } catch {
    return false;
  }

  return false;
}

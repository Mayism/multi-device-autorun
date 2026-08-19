import { randomUUID } from "node:crypto";
import { CaseInput, TaskType } from "../types.js";

function isTaskType(value: string): value is TaskType {
  return value === "full_generation" || value === "continuation" || value === "bug_fix";
}

const managementConsoleTaskTypeMap: Record<string, TaskType> = {
  new_development: "full_generation",
  incremental: "continuation",
  bugfix: "bug_fix",
};

// 启动前先做一遍轻量 task type 推断，确保运行目录命名与实际工作流一致。
export function inferTaskTypeFromCaseInput(
  caseInput: Pick<CaseInput, "promptText" | "patchPath" | "originalProjectProvided">,
): TaskType {
  const prompt = caseInput.promptText.toLowerCase();
  if (prompt.includes("bug") || prompt.includes("修复")) {
    return "bug_fix";
  }
  if (caseInput.originalProjectProvided === false) {
    return "full_generation";
  }
  if (caseInput.patchPath) {
    return "continuation";
  }
  return "full_generation";
}

export function resolveRemoteTaskType(
  remoteType: string,
): TaskType {
  if (isTaskType(remoteType)) {
    return remoteType;
  }
  const mapped = managementConsoleTaskTypeMap[remoteType];
  if (mapped) {
    return mapped;
  }
  throw new Error(
    `Unsupported remote task type: ${remoteType}. Expected new_development, incremental, bugfix, full_generation, continuation, or bug_fix.`,
  );
}

type BuildRunCaseIdInput = {
  now?: Date;
  taskType: TaskType | "case";
  taskId?: number | string;
  uniqueId?: string;
};

// 运行目录命名规则：时间 + task_type + [task_id] + 唯一 id。
export function buildRunCaseId(input: BuildRunCaseIdInput): string {
  const now = input.now ?? new Date();
  const uniqueId = input.uniqueId ?? randomUUID().replace(/-/g, "").slice(0, 8);
  const timestamp =
    [
      now.getUTCFullYear(),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      String(now.getUTCDate()).padStart(2, "0"),
    ].join("") +
    "T" +
    [
      String(now.getUTCHours()).padStart(2, "0"),
      String(now.getUTCMinutes()).padStart(2, "0"),
      String(now.getUTCSeconds()).padStart(2, "0"),
    ].join("");

  const taskIdSegment = input.taskId === undefined ? "" : `_${String(input.taskId)}`;

  return `${timestamp}_${input.taskType}${taskIdSegment}_${uniqueId}`;
}

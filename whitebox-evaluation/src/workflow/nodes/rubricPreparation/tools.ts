import type { ProjectStructureSummary } from "../../../types.js";
import type { ScoreGraphState } from "../../graph/state.js";

/** 变更文件较多时，为 rubric agent 附加裁剪后的 workspace 结构提示。 */
export function buildWorkspaceProjectStructureContext(state: ScoreGraphState): {
  workspaceProjectStructure?: ProjectStructureSummary;
  workspaceProjectStructureNote?: string;
} {
  const changedFiles = state.evidenceSummary?.changedFiles ?? state.changedFiles ?? [];
  const changedFileCount = changedFiles.length;
  const workspaceProjectStructure = state.workspaceProjectStructure;

  if (!workspaceProjectStructure || changedFileCount <= 20) {
    return {};
  }

  return {
    workspaceProjectStructure: {
      ...workspaceProjectStructure,
      topLevelEntries: workspaceProjectStructure.topLevelEntries.slice(0, 20),
      modulePaths: workspaceProjectStructure.modulePaths.slice(0, 20),
      implementationHints: workspaceProjectStructure.implementationHints.slice(0, 10),
    },
    workspaceProjectStructureNote: `当前 changedFiles 共 ${changedFileCount} 个。请先优先检查 effective_patch_path，再根据 patch 中出现的文件路径阅读相关 generated/ 或 original/ 上下文；必要时结合 workspace_project_structure 选择代表性目录或文件辅助理解。`,
  };
}

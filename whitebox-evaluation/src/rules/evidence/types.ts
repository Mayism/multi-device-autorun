import type { EvidenceSummary } from "../../types.js";
import type { ArkFactsIndex } from "../arkfacts/index.js";

// 规则引擎只消费归一化后的文件视图，避免直接耦合真实项目目录结构。
export interface WorkspaceFile {
  relativePath: string;
  content: string;
  patchLineNumbers?: number[];
}

// 收集到的规则证据，统一描述 workspace、original 和 patch 三类输入。
export interface CollectedEvidence {
  workspaceFiles: WorkspaceFile[];
  allWorkspaceFiles?: WorkspaceFile[];
  originalFiles: string[];
  patchText?: string;
  changedFiles: string[];
  caseDir?: string;
  arkFacts?: ArkFactsIndex;
  summary: EvidenceSummary;
}

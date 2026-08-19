export type HvigorModuleBuildTarget = "hap" | "har" | "hsp" | "unknown";

// hvigor 构建检查的输入由 workflow 统一传入，包含开关、运行目录和 patch 范围。
export interface HvigorBuildCheckInput {
  enabled: boolean;
  hvigorRunDir?: string;
  workspaceDir?: string;
  changedFiles: string[];
  changedLineNumbersByFile?: Record<string, number[]>;
  timeoutMs: number;
}

export type CommandResult = {
  status: "success" | "failed" | "timeout";
  stdout: string;
  stderr: string;
  exitCode?: number;
  durationMs: number;
};

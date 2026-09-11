import type { AgentBuildResult, TaskType } from "./types.js";

export interface LocalWhiteboxInput {
  schemaVersion: "whitebox-input-v1";
  caseId: string;
  taskType: TaskType;
  promptPath: string;
  originalProjectPath: string;
  generatedProjectPath: string;
  patchPath?: string;
  outputDir: string;
  agentBuild?: AgentBuildResult;
  /** @deprecated 旧版 Autorun 输入兼容；新版使用 agentBuild。 */
  buildSuccess?: boolean;
  expectedConstraintsPath?: string;
  metadata?: {
    batchId?: string;
    providerId?: string;
    modelId?: string;
    promptSha256?: string;
    patchSha256?: string;
  };
}

export interface LocalWhiteboxRunSummary {
  status: "completed" | "failed";
  caseId: string;
  outputDir: string;
  resultPath?: string;
  reportPath?: string;
  totalScore?: number;
  hardGateTriggered?: boolean;
  error?: string;
}

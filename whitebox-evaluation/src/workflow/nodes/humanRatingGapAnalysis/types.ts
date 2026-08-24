import type { OpencodeRunRequest, OpencodeRunResult } from "../../../agents/opencode/cliRunner.js";
import type { OpencodeRuntimeConfig } from "../../../agents/opencode/config.js";
import type { OpencodeServeManager } from "../../../agents/opencode/serveManager.js";
import type { HumanRatingRecord } from "../../../datasets/humanRating/humanRatingTypes.js";

/** 人工评分差异分析节点输入：单个 case 的人工记录与自动评分结果。 */
export type HumanRatingGapAnalysisNodeInput = {
  caseDir: string;
  manualRatingRecord: HumanRatingRecord;
  resultJson: Record<string, unknown>;
};

/** 人工评分差异分析节点依赖，支持复用 OpenCode runtime 或注入测试 runner。 */
export type HumanRatingGapAnalysisNodeDeps = {
  opencodeRuntime?: OpencodeRuntimeConfig;
  opencodeServeManager?: OpencodeServeManager;
  opencodeRunner?: {
    runPrompt(request: OpencodeRunRequest): Promise<OpencodeRunResult>;
  };
  logger?: {
    warn?(message: string): Promise<void> | void;
  };
};

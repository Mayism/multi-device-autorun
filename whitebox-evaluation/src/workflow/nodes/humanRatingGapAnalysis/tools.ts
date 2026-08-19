import type { OpencodeRunRequest, OpencodeRunResult } from "../../../agents/opencode/cliRunner.js";
import { createOpencodeRuntimeConfig } from "../../../agents/opencode/config.js";
import { createManagedOpencodeRunner } from "../../../agents/opencode/managedRunner.js";
import {
  createOpencodeServeManager,
  ensureOpencodeCliAvailable,
} from "../../../agents/opencode/serveManager.js";
import type { HumanRatingGapAnalysisNodeDeps } from "./types.js";

/** 准备人工评分差异分析需要的 OpenCode runner，并返回对应清理函数。 */
export async function createRuntimeDeps(deps: HumanRatingGapAnalysisNodeDeps): Promise<{
  runPrompt(request: OpencodeRunRequest): Promise<OpencodeRunResult>;
  cleanup(): Promise<void>;
}> {
  if (deps.opencodeRunner) {
    return {
      runPrompt: deps.opencodeRunner.runPrompt,
      cleanup: async () => undefined,
    };
  }

  const runtime =
    deps.opencodeRuntime ?? (await createOpencodeRuntimeConfig({ repoRoot: process.cwd() }));
  const serveManager = deps.opencodeServeManager ?? createOpencodeServeManager(runtime);
  await ensureOpencodeCliAvailable();
  await serveManager.start();
  const runner = createManagedOpencodeRunner({ runtime, serveManager });
  return {
    runPrompt: runner.runPrompt,
    cleanup: async () => {
      if (!deps.opencodeServeManager) {
        await serveManager.stop();
      }
    },
  };
}

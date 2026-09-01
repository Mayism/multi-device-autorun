import { runOpencodeHumanRatingGapAnalysis } from "../../../agents/runners/opencodeHumanRatingGapAnalysis.js";
import type { HumanRatingGapAnalysis } from "../../../datasets/humanRating/humanRatingTypes.js";
import { createRuntimeDeps } from "./tools.js";
import type { HumanRatingGapAnalysisNodeDeps, HumanRatingGapAnalysisNodeInput } from "./types.js";

/** 对比人工评分与自动 result.json，产出差异原因和可回溯分析。 */
export async function humanRatingGapAnalysisNode(
  input: HumanRatingGapAnalysisNodeInput,
  deps: HumanRatingGapAnalysisNodeDeps = {},
): Promise<HumanRatingGapAnalysis> {
  const runtimeDeps = await createRuntimeDeps(deps);
  try {
    const result = await runOpencodeHumanRatingGapAnalysis({
      sandboxRoot: input.caseDir,
      manualRatingRecord: input.manualRatingRecord,
      resultJson: input.resultJson,
      runPrompt: runtimeDeps.runPrompt,
      logger: deps.logger,
    });
    if (result.outcome !== "success" || !result.final_answer) {
      throw new Error(
        `human rating gap analysis failed outcome=${result.outcome} reason=${result.failure_reason ?? "unknown"}`,
      );
    }
    return result.final_answer;
  } finally {
    await runtimeDeps.cleanup();
  }
}

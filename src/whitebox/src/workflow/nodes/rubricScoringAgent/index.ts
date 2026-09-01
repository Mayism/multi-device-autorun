import { runOpencodeRubricScoring } from "../../../agents/runners/opencodeRubricScoring.js";
import type { OpencodeRunRequest, OpencodeRunResult } from "../../../agents/opencode/cliRunner.js";
import { emitNodeStarted } from "../../observability/nodeCustomEvents.js";
import { ScoreGraphState } from "../../graph/state.js";

type RubricScoringDeps = {
  opencode?: {
    sandboxRoot: string;
    runPrompt(request: OpencodeRunRequest): Promise<OpencodeRunResult>;
  };
  logger?: {
    info(message: string): Promise<void>;
    warn(message: string): Promise<void>;
    error(message: string): Promise<void>;
  };
};

function buildSkippedResult(): Partial<ScoreGraphState> {
  return {
    rubricAgentRunnerMode: "opencode",
    rubricAgentRunStatus: "skipped",
    rubricAgentRawText: "",
    rubricScoringResult: undefined,
    rubricAgentRunnerResult: undefined,
  };
}

export async function rubricScoringAgentNode(
  state: ScoreGraphState,
  deps: RubricScoringDeps,
): Promise<Partial<ScoreGraphState>> {
  emitNodeStarted("rubricScoringAgentNode");
  if (!state.rubricScoringPayload) {
    await deps.logger?.warn("rubric agent 评分跳过 reason=缺少 rubric payload");
    return buildSkippedResult();
  }
  if (!deps.opencode) {
    const message = "rubric agent 调用失败，请重新执行用例。reason=未配置 opencode runtime";
    await deps.logger?.error(message);
    throw new Error(message);
  }

  try {
    const runnerResult = await runOpencodeRubricScoring({
      sandboxRoot: deps.opencode.sandboxRoot,
      scoringPayload: state.rubricScoringPayload,
      runPrompt: deps.opencode.runPrompt,
      logger: deps.logger,
    });
    if (!runnerResult.final_answer) {
      throw new Error(
        `rubric agent 调用失败，请重新执行用例。outcome=${runnerResult.outcome} reason=${runnerResult.failure_reason ?? ""}`,
      );
    }

    return {
      rubricAgentRunnerMode: "opencode",
      rubricAgentRunStatus: "success",
      rubricAgentRawText: runnerResult.final_answer_raw_text ?? "",
      rubricScoringResult: runnerResult.final_answer,
      rubricAgentRunnerResult: runnerResult,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.logger?.error(`rubric agent 调用失败 error=${message}`);
    throw error;
  }
}

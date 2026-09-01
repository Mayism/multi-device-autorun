import { runOpencodeRuleAssessment } from "../../../agents/runners/opencodeRuleAssessment.js";
import type { OpencodeRunRequest, OpencodeRunResult } from "../../../agents/opencode/cliRunner.js";
import { emitNodeStarted } from "../../observability/nodeCustomEvents.js";
import { ScoreGraphState } from "../../graph/state.js";

type RuleAssessmentDeps = {
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

function buildNoCandidateResult(): Partial<ScoreGraphState> {
  return {
    ruleAgentRunnerMode: "opencode",
    ruleAgentRunStatus: "not_enabled",
    ruleAgentRunnerResult: undefined,
  };
}

export async function ruleAssessmentAgentNode(
  state: ScoreGraphState,
  deps: RuleAssessmentDeps,
): Promise<Partial<ScoreGraphState>> {
  emitNodeStarted("ruleAssessmentAgentNode");
  if ((state.assistedRuleCandidates?.length ?? 0) === 0) {
    await deps.logger?.warn("rule agent 判定跳过 reason=无候选规则");
    return buildNoCandidateResult();
  }

  if (!deps.opencode) {
    const message = "rule agent 调用失败，请重新执行用例。reason=未配置 opencode runtime";
    await deps.logger?.error(message);
    throw new Error(message);
  }

  try {
    const runnerResult = await runOpencodeRuleAssessment({
      sandboxRoot: deps.opencode.sandboxRoot,
      bootstrapPayload: state.ruleAgentBootstrapPayload,
      runPrompt: deps.opencode.runPrompt,
      logger: deps.logger,
    });
    if (!runnerResult.final_answer) {
      throw new Error(
        `rule agent 调用失败，请重新执行用例。outcome=${runnerResult.outcome} reason=${runnerResult.failure_reason ?? ""}`,
      );
    }

    return {
      ruleAgentRunnerMode: "opencode",
      ruleAgentRunStatus: "success",
      ruleAgentRunnerResult: runnerResult,
      ruleAgentAssessmentResult: runnerResult.final_answer,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.logger?.error(`rule agent 调用失败 error=${message}`);
    throw error;
  }
}

import { ArtifactStore } from "../../../commons/io/artifactStore.js";
import { emitNodeFailed, emitNodeStarted } from "../../observability/nodeCustomEvents.js";
import { ScoreGraphState } from "../../graph/state.js";

async function writeInputArtifacts(state: ScoreGraphState, artifactStore: ArtifactStore) {
  await artifactStore.writeJson(
    state.caseDir,
    "inputs/rubric-scoring-payload.json",
    state.rubricScoringPayload ?? {},
  );
  await artifactStore.writeJson(
    state.caseDir,
    "inputs/rule-agent-bootstrap-payload.json",
    state.ruleAgentBootstrapPayload ?? {},
  );
}

async function writeIntermediateArtifacts(state: ScoreGraphState, artifactStore: ArtifactStore) {
  await artifactStore.writeJson(
    state.caseDir,
    "intermediate/task-understanding.json",
    state.taskUnderstanding,
  );
  await artifactStore.writeJson(
    state.caseDir,
    "intermediate/rule-audit.json",
    state.deterministicRuleResults ?? [],
  );
  await artifactStore.writeJson(
    state.caseDir,
    "intermediate/rubric-snapshot.json",
    state.rubricSnapshot ?? {},
  );
  await artifactStore.writeJson(
    state.caseDir,
    "intermediate/agent-assisted-rule-candidates.json",
    state.assistedRuleCandidates ?? [],
  );
}

function buildRubricAgentArtifact(state: ScoreGraphState): Record<string, unknown> {
  return {
    status: state.rubricAgentRunStatus ?? "skipped",
    raw_text: state.rubricAgentRawText ?? "",
    parsed_result: state.rubricScoringResult ?? null,
    runner_result: state.rubricAgentRunnerResult ?? {
      outcome:
        state.rubricAgentRunStatus === "skipped" || state.rubricAgentRunStatus === "not_enabled"
          ? state.rubricAgentRunStatus
          : "protocol_error",
    },
  };
}

async function writeResultArtifacts(state: ScoreGraphState, artifactStore: ArtifactStore) {
  await artifactStore.writeJson(
    state.caseDir,
    "intermediate/rubric-agent-result.json",
    buildRubricAgentArtifact(state),
  );
  await artifactStore.writeJson(
    state.caseDir,
    "intermediate/rule-agent-result.json",
    state.ruleAgentRunnerResult ?? {
      outcome:
        state.ruleAgentRunStatus === "skipped" || state.ruleAgentRunStatus === "not_enabled"
          ? state.ruleAgentRunStatus
          : "protocol_error",
    },
  );
  await artifactStore.writeJson(
    state.caseDir,
    "intermediate/rule-audit-merged.json",
    state.mergedRuleAuditResults ?? state.deterministicRuleResults ?? [],
  );
  await artifactStore.writeJson(
    state.caseDir,
    "intermediate/score-fusion.json",
    state.scoreComputation?.scoreFusionDetails ?? [],
  );
  await artifactStore.writeJson(state.caseDir, "intermediate/report-schema-version.json", {
    schema_version: "v1",
    result_schema: "report_result_schema.json",
  });
  await artifactStore.writeJson(state.caseDir, "outputs/result.json", state.resultJson);
}

export async function persistAndUploadNode(
  state: ScoreGraphState,
  deps: {
    artifactStore: ArtifactStore;
  },
): Promise<Partial<ScoreGraphState>> {
  emitNodeStarted("persistAndUploadNode");
  try {
    await writeInputArtifacts(state, deps.artifactStore);
    await writeIntermediateArtifacts(state, deps.artifactStore);
    await writeResultArtifacts(state, deps.artifactStore);
    return { resultJson: state.resultJson };
  } catch (error) {
    emitNodeFailed("persistAndUploadNode", error);
    throw error;
  }
}

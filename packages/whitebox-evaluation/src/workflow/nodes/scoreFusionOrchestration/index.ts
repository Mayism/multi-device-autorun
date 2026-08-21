import path from "node:path";
import { buildRubricSnapshot } from "../../../agents/normalization/ruleAssistance.js";
import { getConfig } from "../../../config.js";
import { fuseRubricScoreWithRules } from "../../../scoring/scoreFusion.js";
import { loadRiskTaxonomy } from "../../../scoring/riskTaxonomy.js";
import { loadRubricForTaskType } from "../../../scoring/rubricLoader.js";
import { emitNodeFailed, emitNodeStarted } from "../../observability/nodeCustomEvents.js";
import { ScoreGraphState } from "../../graph/state.js";

export async function scoreFusionOrchestrationNode(
  state: ScoreGraphState,
): Promise<Partial<ScoreGraphState>> {
  emitNodeStarted("scoreFusionOrchestrationNode");
  try {
    const config = getConfig();
    const effectiveRuleAuditResults =
      (state.mergedRuleAuditResults?.length ?? 0) > 0
        ? state.mergedRuleAuditResults
        : (state.deterministicRuleResults ?? []);
    const rubric = await loadRubricForTaskType(state.taskType, config.referenceRoot);
    const riskTaxonomy = loadRiskTaxonomy(
      path.resolve(config.referenceRoot, "..", "risks", "risk-taxonomy.yaml"),
    );
    const scoreComputation = fuseRubricScoreWithRules({
      taskType: state.taskType,
      rubric,
      rubricSnapshot: state.rubricSnapshot ?? buildRubricSnapshot(rubric),
      rubricScoringResult: state.rubricScoringResult,
      rubricAgentRunStatus: state.rubricAgentRunStatus ?? "skipped",
      ruleAuditResults: effectiveRuleAuditResults,
      ruleViolations: state.ruleViolations ?? [],
      evidenceSummary: state.evidenceSummary ?? {
        workspaceFileCount: 0,
        originalFileCount: 0,
        changedFileCount: 0,
        changedFiles: [],
        hasPatch: false,
      },
      caseRuleDefinitions: state.caseRuleDefinitions ?? [],
      hvigorBuildCheckSummary: state.hvigorBuildCheckSummary,
      riskTaxonomy,
    });

    return { scoreComputation };
  } catch (error) {
    emitNodeFailed("scoreFusionOrchestrationNode", error);
    throw error;
  }
}

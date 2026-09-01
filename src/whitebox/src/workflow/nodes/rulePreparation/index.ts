import path from "node:path";
import { buildAgentBootstrapPayload } from "../../../agents/normalization/ruleAssistance.js";
import { runRuleEngine } from "../../../rules/core/ruleEngine.js";
import { resolveEnabledRulePackIds } from "../../../rules/registry/rulePackRegistry.js";
import { emitNodeFailed, emitNodeStarted } from "../../observability/nodeCustomEvents.js";
import { ScoreGraphState } from "../../graph/state.js";

export async function rulePreparationNode(
  state: ScoreGraphState,
  deps: {
    referenceRoot: string;
    logger?: { info(message: string): Promise<void> };
  },
): Promise<Partial<ScoreGraphState>> {
  emitNodeStarted("rulePreparationNode");
  try {
    const enabledRulePackIds = resolveEnabledRulePackIds({
      crossDeviceAdaptation: state.taskUnderstanding?.crossDeviceAdaptation,
    });
    const result = await runRuleEngine({
      referenceRoot: deps.referenceRoot,
      caseInput: state.caseInput,
      taskType: state.taskType,
      runtimeRules: state.caseRuleDefinitions,
      enabledRulePackIds,
    });
    const caseRoot = state.sourceCasePath ?? path.dirname(state.caseInput.originalProjectPath);
    const payload = buildAgentBootstrapPayload({
      caseInput: state.caseInput,
      caseRoot,
      effectivePatchPath: state.effectivePatchPath,
      taskType: state.taskType,
      taskUnderstanding: state.taskUnderstanding,
      assistedRuleCandidates: result.assistedRuleCandidates,
    });
    await deps.logger?.info(
      `规则准备完成 rules=${result.staticRuleAuditResults.length} violations=${result.ruleViolations.length} candidates=${result.assistedRuleCandidates.length} deterministic=${result.deterministicRuleResults.length}`,
    );

    return {
      staticRuleAuditResults: result.staticRuleAuditResults,
      deterministicRuleResults: result.deterministicRuleResults,
      enabledRulePacks: result.enabledRulePacks,
      assistedRuleCandidates: result.assistedRuleCandidates,
      ruleEvidenceIndex: result.ruleEvidenceIndex,
      ruleViolations: result.ruleViolations,
      evidenceSummary: result.evidenceSummary,
      changedFiles: result.evidenceSummary.changedFiles,
      changedLineNumbersByFile: result.evidenceSummary.changedLineNumbersByFile,
      changedFileCount: result.evidenceSummary.changedFileCount,
      ruleAgentBootstrapPayload: payload,
    };
  } catch (error) {
    emitNodeFailed("rulePreparationNode", error);
    throw error;
  }
}

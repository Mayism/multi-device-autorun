import path from "node:path";
import { buildRubricSnapshot } from "../../../agents/normalization/ruleAssistance.js";
import { buildOpencodeRubricPayload } from "../../../agents/prompts/rubricPrompt.js";
import { loadRubricForTaskType } from "../../../scoring/rubricLoader.js";
import { loadRiskTaxonomy } from "../../../scoring/riskTaxonomy.js";
import { emitNodeFailed, emitNodeStarted } from "../../observability/nodeCustomEvents.js";
import { ScoreGraphState } from "../../graph/state.js";
import { buildWorkspaceProjectStructureContext } from "./tools.js";

/** rubric 准备节点：加载评分标准、风险分类，并构造 rubric agent payload。 */
export async function rubricPreparationNode(
  state: ScoreGraphState,
  deps: {
    referenceRoot: string;
    logger?: { info(message: string): Promise<void> };
  },
): Promise<Partial<ScoreGraphState>> {
  emitNodeStarted("rubricPreparationNode");
  try {
    const rubric = await loadRubricForTaskType(state.taskType, deps.referenceRoot);
    const riskTaxonomyPath = path.resolve(deps.referenceRoot, "..", "risks", "risk-taxonomy.yaml");
    const riskTaxonomy = loadRiskTaxonomy(riskTaxonomyPath);
    const rubricSnapshot = {
      ...buildRubricSnapshot(rubric),
      risk_taxonomy: riskTaxonomy.entries.map((entry) => ({
        code: entry.code,
        level: entry.level,
        title: entry.title,
        description: entry.description,
      })),
    };
    const caseRoot = state.sourceCasePath ?? path.dirname(state.caseInput.originalProjectPath);
    const payload = buildOpencodeRubricPayload({
      caseInput: state.caseInput,
      caseRoot,
      effectivePatchPath: state.effectivePatchPath,
      taskType: state.taskType,
      taskUnderstanding: state.taskUnderstanding,
      rubricSnapshot,
      ...buildWorkspaceProjectStructureContext(state),
    });
    await deps.logger?.info(`rubric 加载完成 taskType=${state.taskType}`);

    return {
      rubricSnapshot,
      rubricScoringPayload: payload,
    };
  } catch (error) {
    emitNodeFailed("rubricPreparationNode", error);
    throw error;
  }
}

import type {
  CaseInput,
  ConstraintSummary,
  LoadedRubricSnapshot,
  ProjectStructureSummary,
  RubricScoringPayload,
  TaskType,
} from "../../types.js";

type BuildOpencodeRubricPayloadInput = {
  caseInput: CaseInput;
  caseRoot: string;
  effectivePatchPath?: string;
  taskType: TaskType;
  taskUnderstanding: ConstraintSummary;
  rubricSnapshot: LoadedRubricSnapshot;
  workspaceProjectStructure?: ProjectStructureSummary;
  workspaceProjectStructureNote?: string;
};

function omitRiskTaxonomy(rubricSnapshot: LoadedRubricSnapshot): LoadedRubricSnapshot {
  const { risk_taxonomy: _riskTaxonomy, ...rubricSummary } = rubricSnapshot;
  return rubricSummary;
}

export function buildOpencodeRubricPayload(
  input: BuildOpencodeRubricPayloadInput,
): RubricScoringPayload {
  return {
    case_context: {
      case_id: input.caseInput.caseId,
      case_root: input.caseRoot,
      task_type: input.taskType,
      original_prompt_summary: input.caseInput.promptText,
      original_project_path: input.caseInput.originalProjectPath,
      generated_project_path: input.caseInput.generatedProjectPath,
      effective_patch_path: input.effectivePatchPath,
    },
    task_understanding: input.taskUnderstanding,
    rubric_summary: omitRiskTaxonomy(input.rubricSnapshot),
    workspace_project_structure: input.workspaceProjectStructure,
    workspace_project_structure_note: input.workspaceProjectStructureNote,
    response_contract: {
      output_language: "zh-CN",
      json_only: true,
      required_top_level_fields: [
        "summary",
        "item_scores",
        "hard_gate_candidates",
        "risks",
        "strengths",
        "main_issues",
      ],
    },
  };
}

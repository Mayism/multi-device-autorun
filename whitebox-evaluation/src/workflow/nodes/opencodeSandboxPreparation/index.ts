import { buildOpencodeSandbox } from "../../../agents/opencode/sandboxBuilder.js";
import { ScoreGraphState } from "../../graph/state.js";

export async function opencodeSandboxPreparationNode(
  state: ScoreGraphState,
): Promise<Partial<ScoreGraphState>> {
  if (state.opencodeSandboxRoot) {
    return {};
  }

  const sandbox = await buildOpencodeSandbox({
    caseDir: state.caseDir,
    generatedProjectPath: state.caseInput.generatedProjectPath,
    originalProjectPath: state.caseInput.originalProjectPath,
    originalProjectProvided: state.caseInput.originalProjectProvided,
    effectivePatchPath: state.effectivePatchPath ?? state.caseInput.patchPath,
    metadata: {
      case_id: state.caseInput.caseId,
      prompt_text: state.caseInput.promptText,
      original_project_provided: state.caseInput.originalProjectProvided ?? true,
      task_understanding: state.taskUnderstanding,
      task_type: state.taskType,
      input_mode: state.inputMode,
    },
  });

  return {
    opencodeSandboxRoot: sandbox.root,
  };
}

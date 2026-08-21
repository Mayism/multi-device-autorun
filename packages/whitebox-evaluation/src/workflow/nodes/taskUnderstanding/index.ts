import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { emitNodeFailed, emitNodeStarted } from "../../observability/nodeCustomEvents.js";
import type { ScoreGraphState } from "../../graph/state.js";
import type { TaskUnderstandingAgentInput } from "../../../types.js";
import {
  buildTaskUnderstandingSandbox,
  collectProjectStructure,
  ensureEffectivePatchPath,
  loadTaskCaseRuleDefinitions,
  pathExists,
  persistCaseRuleDefinitions,
  persistTaskUnderstanding,
  readPatchSummary,
  understandWithAgent,
} from "./tools.js";
import { isTaskUnderstandingDeps, type TaskUnderstandingDeps } from "./types.js";

async function resolveProjectStructureRoot(state: ScoreGraphState): Promise<string> {
  return state.caseInput.originalProjectProvided === false ||
    !(await pathExists(state.caseInput.originalProjectPath))
    ? state.caseInput.generatedProjectPath
    : state.caseInput.originalProjectPath;
}

function buildAgentInput(input: {
  state: ScoreGraphState;
  projectStructure: TaskUnderstandingAgentInput["projectStructure"];
  patchSummary: TaskUnderstandingAgentInput["patchSummary"];
}): TaskUnderstandingAgentInput {
  return {
    caseId: input.state.caseInput.caseId,
    promptText: input.state.caseInput.promptText,
    originalProjectPath: input.state.caseInput.originalProjectPath,
    generatedProjectPath: input.state.caseInput.generatedProjectPath,
    originalProjectProvided: input.state.caseInput.originalProjectProvided,
    taskType: input.state.taskType,
    projectStructure: input.projectStructure,
    patchSummary: input.patchSummary,
  };
}

function buildTaskUnderstandingUpdate(input: {
  state: ScoreGraphState;
  effectivePatchPath?: string;
  patchSummary: TaskUnderstandingAgentInput["patchSummary"];
  opencodeSandboxRoot?: string;
  caseRuleDefinitions: Awaited<ReturnType<typeof loadTaskCaseRuleDefinitions>>;
  taskUnderstanding: Awaited<ReturnType<typeof understandWithAgent>>;
  workspaceProjectStructure: TaskUnderstandingAgentInput["projectStructure"];
}): Partial<ScoreGraphState> {
  return {
    caseInput: { ...input.state.caseInput, patchPath: input.effectivePatchPath },
    effectivePatchPath: input.effectivePatchPath,
    hasPatch: input.patchSummary.hasPatch,
    changedFiles: input.patchSummary.changedFiles,
    changedFileCount: input.patchSummary.changedFiles.length,
    taskType: input.state.taskType,
    opencodeSandboxRoot: input.opencodeSandboxRoot,
    caseRuleDefinitions: input.caseRuleDefinitions,
    taskUnderstanding: input.taskUnderstanding,
    workspaceProjectStructure: input.workspaceProjectStructure,
  };
}

/** 任务理解节点：生成工程结构、变更摘要和约束理解，供后续规则与 rubric 节点评分。 */
export async function taskUnderstandingNode(
  state: ScoreGraphState,
  depsOrConfig: TaskUnderstandingDeps | LangGraphRunnableConfig = {},
  maybeConfig?: LangGraphRunnableConfig,
): Promise<Partial<ScoreGraphState>> {
  const deps = isTaskUnderstandingDeps(depsOrConfig) ? depsOrConfig : {};
  const config = isTaskUnderstandingDeps(depsOrConfig) ? maybeConfig : depsOrConfig;
  emitNodeStarted("taskUnderstandingNode", config);

  try {
    if (!state.taskType) {
      throw new Error("taskUnderstandingNode requires taskType in state.");
    }
    const projectStructureRoot = await resolveProjectStructureRoot(state);
    const projectStructure = await collectProjectStructure(projectStructureRoot);
    const workspaceProjectStructure = await collectProjectStructure(
      state.caseInput.generatedProjectPath,
    );
    const effectivePatchPath = await ensureEffectivePatchPath(state, deps);
    const patchSummary = await readPatchSummary(effectivePatchPath);
    const caseRuleDefinitions = await loadTaskCaseRuleDefinitions(state);
    const opencodeSandbox = await buildTaskUnderstandingSandbox({
      state,
      deps,
      effectivePatchPath,
      patchSummary,
      projectStructure,
      workspaceProjectStructure,
    });
    const agentInput = buildAgentInput({ state, projectStructure, patchSummary });
    const taskUnderstanding = await understandWithAgent(agentInput, deps, opencodeSandbox?.root);
    await persistTaskUnderstanding(state, deps, taskUnderstanding);
    await persistCaseRuleDefinitions(state, deps, caseRuleDefinitions);

    return buildTaskUnderstandingUpdate({
      state,
      effectivePatchPath,
      patchSummary,
      opencodeSandboxRoot: opencodeSandbox?.root,
      caseRuleDefinitions,
      taskUnderstanding,
      workspaceProjectStructure,
    });
  } catch (error) {
    emitNodeFailed("taskUnderstandingNode", error, config);
    throw error;
  }
}

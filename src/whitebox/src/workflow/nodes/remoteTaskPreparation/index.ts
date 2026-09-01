import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadCaseFromPath } from "../../../commons/io/caseLoader.js";
import { preparePatchEvidenceSummary } from "../../../rules/evidence/patchEvidenceSummary.js";
import {
  downloadManifestToDirectory,
  type RemoteDownloadLogger,
} from "../../../commons/io/downloader.js";
import { resolveRemoteTaskType } from "../../../service/runCaseId.js";
import type { RemoteEvaluationTask } from "../../../types.js";
import { emitNodeFailed, emitNodeStarted } from "../../observability/nodeCustomEvents.js";
import type { ScoreGraphState } from "../../graph/state.js";
import { buildRemotePrompt, shouldMaterializeExpectedConstraints } from "./tools.js";

async function writeRemoteTaskCaseFiles(state: ScoreGraphState, casePath: string): Promise<void> {
  if (!state.remoteTask) {
    throw new Error("Workflow requires remoteTask.");
  }
  await fs.mkdir(casePath, { recursive: true });
  await fs.writeFile(
    path.join(casePath, "input.txt"),
    buildRemotePrompt(state.remoteTask),
    "utf-8",
  );
  if (shouldMaterializeExpectedConstraints(state.remoteTask.testCase.expectedOutput)) {
    await fs.writeFile(
      path.join(casePath, "expected_constraints.yaml"),
      state.remoteTask.testCase.expectedOutput,
      "utf-8",
    );
  }
}

async function downloadOriginalProject(
  task: RemoteEvaluationTask,
  casePath: string,
  logger?: RemoteDownloadLogger,
): Promise<string[]> {
  const originalDir = path.join(casePath, "original");
  const originalFiles = task.testCase.fileUrl.trim()
    ? await downloadManifestToDirectory(task.testCase.fileUrl, originalDir, {
        label: "original_project",
        logger,
      })
    : [];
  if (originalFiles.length === 0) {
    await fs.mkdir(originalDir, { recursive: true });
  }
  return originalFiles;
}

async function downloadWorkspaceProject(
  task: RemoteEvaluationTask,
  casePath: string,
  logger?: RemoteDownloadLogger,
): Promise<string[]> {
  return downloadManifestToDirectory(
    task.executionResult.outputCodeUrl,
    path.join(casePath, "workspace"),
    { label: "workspace_project", logger },
  );
}

/** 远端任务准备节点：下载远端工程、生成本地 case，并提取 patch 证据。 */
export async function remoteTaskPreparationNode(
  state: ScoreGraphState,
  deps: { logger?: RemoteDownloadLogger } = {},
): Promise<Partial<ScoreGraphState>> {
  emitNodeStarted("remoteTaskPreparationNode");
  let rootDir: string | undefined;
  try {
    if (!state.remoteTask) {
      throw new Error("Workflow requires remoteTask.");
    }

    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "hmos-remote-task-"));
    const casePath = path.join(rootDir, `remote-task-${state.remoteTask.taskId}`);
    await writeRemoteTaskCaseFiles(state, casePath);
    const originalFiles = await downloadOriginalProject(state.remoteTask, casePath, deps.logger);
    const workspaceFiles = await downloadWorkspaceProject(state.remoteTask, casePath, deps.logger);
    const loadedCaseInput = await loadCaseFromPath(casePath);
    const patchEvidence = await preparePatchEvidenceSummary({
      caseInput: loadedCaseInput,
      caseDir: state.caseDir ?? casePath,
    });
    const taskType = resolveRemoteTaskType(state.remoteTask.testCase.type);

    return {
      caseInput: patchEvidence.caseInput,
      sourceCasePath: casePath,
      remoteTaskRootDir: rootDir,
      inputMode: "remote",
      originalFileCount: originalFiles.length,
      workspaceFileCount: workspaceFiles.length,
      effectivePatchPath: patchEvidence.effectivePatchPath,
      hasPatch: patchEvidence.evidenceSummary.hasPatch,
      changedFiles: patchEvidence.evidenceSummary.changedFiles,
      changedLineNumbersByFile: patchEvidence.evidenceSummary.changedLineNumbersByFile ?? {},
      changedFileCount: patchEvidence.evidenceSummary.changedFileCount,
      remoteBuildSuccess: state.remoteTask.executionResult.isBuildSuccess,
      taskType,
    };
  } catch (error) {
    if (rootDir && error instanceof Error) {
      Object.assign(error, { remoteTaskRootDir: rootDir });
    }
    emitNodeFailed("remoteTaskPreparationNode", error);
    throw error;
  }
}

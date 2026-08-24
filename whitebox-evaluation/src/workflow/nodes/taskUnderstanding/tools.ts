import fs from "node:fs/promises";
import path from "node:path";
import { runOpencodeTaskUnderstanding } from "../../../agents/runners/opencodeTaskUnderstanding.js";
import { generateCasePatch } from "../../../commons/io/patchGenerator.js";
import {
  filterPatchTextForIgnoredFiles,
  isIgnoredCaseFilePath,
} from "../../../commons/utils/ignoredFiles.js";
import { buildOpencodeSandbox } from "../../../agents/opencode/sandboxBuilder.js";
import { loadCaseConstraintRules } from "../../../rules/case-constraints/loader.js";
import type { ScoreGraphState } from "../../graph/state.js";
import type {
  CaseRuleDefinition,
  ConstraintSummary,
  PatchSummary,
  ProjectStructureSummary,
  TaskUnderstandingAgentInput,
} from "../../../types.js";
import type { TaskUnderstandingDeps } from "./types.js";

const ignoredDirectoryNames = new Set([
  ".git",
  ".hvigor",
  ".idea",
  ".vscode",
  "build",
  "dist",
  "node_modules",
  "oh_modules",
]);

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

type ProjectStructureScan = {
  rootPath: string;
  files: string[];
  topLevelEntries: string[];
  omittedFileCount: number;
  maxFiles: number;
  maxDepth: number;
};

async function readDirectoryEntries(dirPath: string) {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function visitProjectStructureDir(
  scan: ProjectStructureScan,
  dirPath: string,
  depth: number,
): Promise<void> {
  if (depth > scan.maxDepth || scan.files.length >= scan.maxFiles) {
    scan.omittedFileCount += 1;
    return;
  }
  const entries = await readDirectoryEntries(dirPath);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    await visitProjectStructureEntry(scan, dirPath, depth, entry);
  }
}

async function visitProjectStructureEntry(
  scan: ProjectStructureScan,
  dirPath: string,
  depth: number,
  entry: Awaited<ReturnType<typeof readDirectoryEntries>>[number],
): Promise<void> {
  if (depth === 0) {
    scan.topLevelEntries.push(entry.name);
  }
  if (ignoredDirectoryNames.has(entry.name)) {
    return;
  }
  const absolutePath = path.join(dirPath, entry.name);
  if (entry.isDirectory()) {
    await visitProjectStructureDir(scan, absolutePath, depth + 1);
    return;
  }
  if (!entry.isFile()) {
    return;
  }
  const relativePath = normalizeRelativePath(path.relative(scan.rootPath, absolutePath));
  if (!isIgnoredCaseFilePath(relativePath) && scan.files.length < scan.maxFiles) {
    scan.files.push(relativePath);
  } else {
    scan.omittedFileCount += 1;
  }
}

function buildProjectStructureSummary(scan: ProjectStructureScan): ProjectStructureSummary {
  const files = scan.files;
  const modulePaths = unique(
    files
      .filter((file) => file.endsWith("/src/main/module.json5") || file === "src/main/module.json5")
      .map((file) => {
        const marker = "/src/main/module.json5";
        if (file.endsWith(marker)) {
          return file.slice(0, -marker.length);
        }
        return ".";
      }),
  );
  const implementationHints = [
    modulePaths.length > 0 ? `HarmonyOS 模块: ${modulePaths.join(", ")}` : "",
    files.some((file) => file.endsWith(".ets")) ? "技术栈: ArkTS/ETS 页面与组件实现" : "",
    files.some((file) => file.includes("/viewmodels/"))
      ? "分层: 存在 viewmodels 目录，需保持状态管理分层"
      : "",
    files.some((file) => file.includes("/components/"))
      ? "分层: 存在 components 目录，需复用组件边界"
      : "",
    files.some((file) => file.includes("/resources/"))
      ? "资源: 存在 resources 目录，需遵循资源引用约束"
      : "",
  ].filter(Boolean);

  return {
    rootPath: scan.rootPath,
    topLevelEntries: unique(scan.topLevelEntries).sort(),
    modulePaths,
    implementationHints,
    omittedFileCount: scan.omittedFileCount,
  };
}

/** 收集项目结构摘要，供任务理解 Agent 判断工程类型、模块边界和实现线索。 */
export async function collectProjectStructure(rootPath: string): Promise<ProjectStructureSummary> {
  const scan = {
    rootPath,
    files: [],
    topLevelEntries: [],
    omittedFileCount: 0,
    maxFiles: 500,
    maxDepth: 8,
  };
  await visitProjectStructureDir(scan, rootPath, 0);
  return buildProjectStructureSummary(scan);
}

function inferChangedFileFromDiffLine(line: string): string | undefined {
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  if (!match) {
    return undefined;
  }
  return match[2];
}

function inferChangedFileFromMarkerLine(line: string): string | undefined {
  const match = /^\+\+\+ b\/(.+)$/.exec(line);
  if (!match || match[1] === "/dev/null") {
    return undefined;
  }
  return match[1];
}

type PatchStats = {
  changedFiles: string[];
  changeTypes: Set<string>;
  addedLines: number;
  deletedLines: number;
};

function emptyPatchSummary(): PatchSummary {
  return {
    hasPatch: false,
    changedFiles: [],
    affectedRoots: [],
    addedLines: 0,
    deletedLines: 0,
    changeTypes: [],
    intrusionLevel: "none",
    rawPatchLength: 0,
  };
}

function collectPatchLineStats(stats: PatchStats, line: string): void {
  const fromDiff = inferChangedFileFromDiffLine(line);
  const fromMarker = inferChangedFileFromMarkerLine(line);
  if (fromDiff) {
    stats.changedFiles.push(fromDiff);
  }
  if (fromMarker) {
    stats.changedFiles.push(fromMarker);
  }
  collectPatchLineTypeStats(stats, line);
}

function collectPatchLineTypeStats(stats: PatchStats, line: string): void {
  if (line === "new file mode" || line.startsWith("new file mode ")) {
    stats.changeTypes.add("added_file");
  } else if (line === "deleted file mode" || line.startsWith("deleted file mode ")) {
    stats.changeTypes.add("deleted_file");
  } else if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
    stats.changeTypes.add("renamed_file");
  } else if (line.startsWith("+") && !line.startsWith("+++")) {
    stats.addedLines += 1;
  } else if (line.startsWith("-") && !line.startsWith("---")) {
    stats.deletedLines += 1;
  }
}

function resolveIntrusionLevel(
  fileCount: number,
  changedLineCount: number,
): PatchSummary["intrusionLevel"] {
  if (fileCount === 0) {
    return "none";
  }
  if (fileCount <= 2 && changedLineCount <= 80) {
    return "low";
  }
  return fileCount <= 8 && changedLineCount <= 300 ? "medium" : "high";
}

function buildPatchSummary(stats: PatchStats, rawPatchLength: number): PatchSummary {
  if (stats.addedLines > 0 || stats.deletedLines > 0) {
    stats.changeTypes.add("modified");
  }
  const files = unique(stats.changedFiles);
  const affectedRoots = unique(files.map((file) => file.split("/")[0] ?? file));
  const changedLineCount = stats.addedLines + stats.deletedLines;
  return {
    hasPatch: true,
    changedFiles: files,
    affectedRoots,
    addedLines: stats.addedLines,
    deletedLines: stats.deletedLines,
    changeTypes: Array.from(stats.changeTypes),
    intrusionLevel: resolveIntrusionLevel(files.length, changedLineCount),
    rawPatchLength,
  };
}

/** 将 patch 文本压缩为任务理解阶段需要的变更摘要。 */
export function summarizePatch(patchText: string): PatchSummary {
  if (!patchText.trim()) {
    return emptyPatchSummary();
  }
  const stats: PatchStats = {
    changedFiles: [],
    changeTypes: new Set<string>(),
    addedLines: 0,
    deletedLines: 0,
  };
  for (const line of patchText.split(/\r?\n/)) {
    collectPatchLineStats(stats, line);
  }
  return buildPatchSummary(stats, patchText.length);
}

export async function readPatchSummary(patchPath?: string): Promise<PatchSummary> {
  if (!patchPath) {
    return summarizePatch("");
  }
  const patchText = filterPatchTextForIgnoredFiles(
    await fs.readFile(patchPath, "utf-8").catch(() => ""),
  );
  return summarizePatch(patchText);
}

/** 调用任务理解 Agent，失败时统一包装为节点可读的中文错误。 */
export async function understandWithAgent(
  input: TaskUnderstandingAgentInput,
  deps: TaskUnderstandingDeps,
  sandboxRoot?: string,
): Promise<ConstraintSummary> {
  if (!deps.opencode || !sandboxRoot) {
    throw new Error("任务理解 opencode runtime 未配置");
  }

  try {
    await deps.logger?.info("任务理解 opencode 调用开始");
    const result = await runOpencodeTaskUnderstanding({
      sandboxRoot,
      agentInput: input,
      runPrompt: deps.opencode.runPrompt,
      logger: deps.logger,
    });
    if (result.outcome === "success" && result.summary) {
      await deps.logger?.info("任务理解 opencode 调用完成");
      return result.summary;
    }
    throw new Error(`任务理解 opencode 输出无效 reason=${result.failure_reason ?? result.outcome}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`任务理解 opencode 调用失败 reason=${message}`);
  }
}

export async function persistTaskUnderstanding(
  state: ScoreGraphState,
  deps: TaskUnderstandingDeps,
  summary: ConstraintSummary,
): Promise<void> {
  if (!deps.artifactStore || !state.caseDir) {
    return;
  }
  await deps.artifactStore.writeJson(
    state.caseDir,
    "intermediate/task-understanding.json",
    summary,
  );
}

/** 统一生成 effective patch：优先使用非空输入 patch，否则由原始/生成工程自动 diff。 */
export async function ensureEffectivePatchPath(
  state: ScoreGraphState,
  deps: TaskUnderstandingDeps,
): Promise<string | undefined> {
  if (state.caseInput.patchPath) {
    const patchText = filterPatchTextForIgnoredFiles(
      await fs.readFile(state.caseInput.patchPath, "utf-8").catch(() => ""),
    );

    if (patchText.trim().length > 0) {
      if (!deps.artifactStore || !state.caseDir) {
        return state.caseInput.patchPath;
      }

      const outputPath = path.join(state.caseDir, "intermediate", "effective.patch");
      await deps.artifactStore.writeText(
        state.caseDir,
        path.relative(state.caseDir, outputPath),
        patchText,
      );
      return outputPath;
    }
  }

  if (!deps.artifactStore || !state.caseDir) {
    return state.caseInput.patchPath;
  }

  if (!(await pathExists(state.caseInput.originalProjectPath))) {
    await fs.mkdir(state.caseInput.originalProjectPath, { recursive: true });
  }
  if (!(await pathExists(state.caseInput.generatedProjectPath))) {
    return state.caseInput.patchPath;
  }

  const outputPath = path.join(
    state.caseDir,
    "intermediate",
    state.caseInput.patchPath ? "effective.patch" : "generated.patch",
  );

  if (state.caseInput.patchPath) {
    await deps.artifactStore.writeText(state.caseDir, path.relative(state.caseDir, outputPath), "");
  }

  const caseRoot = path.dirname(state.caseInput.originalProjectPath);
  return generateCasePatch(caseRoot, outputPath);
}

export async function persistCaseRuleDefinitions(
  state: ScoreGraphState,
  deps: TaskUnderstandingDeps,
  caseRuleDefinitions: CaseRuleDefinition[],
): Promise<void> {
  if (!deps.artifactStore || !state.caseDir) {
    return;
  }

  await deps.artifactStore.writeJson(
    state.caseDir,
    "intermediate/case-rule-definitions.json",
    caseRuleDefinitions,
  );
}

export async function loadTaskCaseRuleDefinitions(
  state: ScoreGraphState,
): Promise<CaseRuleDefinition[]> {
  return loadCaseConstraintRules(state.caseInput);
}

export async function buildTaskUnderstandingSandbox(input: {
  state: ScoreGraphState;
  deps: TaskUnderstandingDeps;
  effectivePatchPath?: string;
  patchSummary: PatchSummary;
  projectStructure: ProjectStructureSummary;
  workspaceProjectStructure: ProjectStructureSummary;
}) {
  const { state, deps } = input;
  return deps.opencode && state.caseDir
    ? buildOpencodeSandbox({
        caseDir: state.caseDir,
        generatedProjectPath: state.caseInput.generatedProjectPath,
        originalProjectPath: state.caseInput.originalProjectPath,
        originalProjectProvided: state.caseInput.originalProjectProvided,
        effectivePatchPath: input.effectivePatchPath,
        metadata: {
          case_id: state.caseInput.caseId,
          prompt_text: state.caseInput.promptText,
          original_project_provided: state.caseInput.originalProjectProvided ?? true,
          patch_summary: input.patchSummary,
          project_structure: input.projectStructure,
          workspace_project_structure: input.workspaceProjectStructure,
        },
      })
    : undefined;
}

import fs from "node:fs/promises";
import path from "node:path";
import { loadExecutionConfig } from "../execution/config.js";
import { buildExecutionPlan } from "../execution/plan.js";
import { runExecution } from "../execution/runner.js";
import { deriveExecutionStatus } from "../execution/result.js";
import { renderSummaryMarkdown } from "../execution/summary.js";
import { defaultCommandExecutor } from "../execution/command.js";
import { createLoggedCommandExecutor } from "../logging/command.js";
import { RunnerLogger } from "../logging/logger.js";
import { formatRunnerError } from "../logging/types.js";
import { removeWithRetry, stopHvigorDaemon } from "../execution/utils/rm.js";
import type {
  CommandResult,
  BuildResult,
  ExecutionConfig,
  ExecutionResult,
} from "../execution/types/index.js";
import {
  buildCaseDeviceSelection,
  buildCaseExecutionGroups,
  loadCaseMetadata,
} from "./config.js";
import { applyPatch, copyBaseProject } from "./patch.js";
import {
  deriveCaseStatus,
  metadataForResult,
  renderCaseSummary,
} from "./result.js";
import type {
  CaseDeviceSelection,
  CaseModuleRunResult,
  CaseMetadata,
  CaseResult,
  RunCaseInput,
} from "./types/index.js";
import { withSweTabletCompatibility } from "./deviceCompatibility.js";

interface CaseRunContext {
  startedTime: number;
  startedAt: string;
  metadata: CaseMetadata;
  outDir: string;
  out: string;
  workProject: string;
  nodePath: string;
  hvigorw: string;
  diagnostics: string[];
  runs: CaseResult["runs"];
  logger: RunnerLogger;
}

interface CaseRunBootstrap {
  startedTime: number;
  caseDir: string;
  outDir: string;
  logger: RunnerLogger;
}

interface PreparedExecutionGroup {
  module?: string;
  executionConfig: ExecutionConfig;
  deviceSelection: CaseDeviceSelection;
}

export async function runOhosTestCase(
  input: RunCaseInput,
): Promise<CaseResult> {
  const startedTime = Date.now();
  const caseDir = path.resolve(input.caseDir);
  const outDir = resolveOutDir(input, caseDir, startedTime);
  await fs.mkdir(outDir, { recursive: true });
  const logger = RunnerLogger.create(path.join(outDir, "commands.jsonl"), {
    phase: "case",
  });

  try {
    return await runCaseWithLogger(input, {
      startedTime,
      caseDir,
      outDir,
      logger,
    });
  } catch (error) {
    logger.recordError(error);
    throw error;
  } finally {
    await logger.close();
  }
}

async function runCaseWithLogger(
  input: RunCaseInput,
  bootstrap: CaseRunBootstrap,
): Promise<CaseResult> {
  let metadata: CaseMetadata;
  try {
    metadata = await loadCaseMetadata(bootstrap.caseDir);
  } catch (error) {
    bootstrap.logger.recordError(error);
    const result = failedCaseResult(
      input,
      bootstrap.caseDir,
      bootstrap.outDir,
      bootstrap.startedTime,
      error,
    );
    await writeFailedCaseArtifacts(result, bootstrap.outDir);
    return result;
  }
  const context = createCaseRunContext(
    input,
    bootstrap.startedTime,
    bootstrap.outDir,
    metadata,
    bootstrap.logger,
  );
  try {
    await runCaseComparisons(input, context);
  } catch (error) {
    context.diagnostics.push(formatRunnerError(error));
    context.logger.recordError(error);
  }
  const result = buildCaseResult(input, context);
  await writeCaseArtifacts(result, context);
  await cleanupCaseWorkdir(input, context, result);
  return result;
}

async function runCaseComparisons(
  input: RunCaseInput,
  context: CaseRunContext,
): Promise<void> {
  const runMode = input.runMode ?? "answer";
  const runPatchCommand = loggedPatchCommand(input, context);
  await copyBaseProject({
    baseProject: context.metadata.baseProject,
    workProject: context.workProject,
  });
  await applyPatch({
    project: context.workProject,
    patchFile: context.metadata.testPatch,
    label: "test_patch",
    commandExecutor: runPatchCommand,
  });

  const { executionGroups, deviceSelection } = await prepareCaseExecution(
    input,
    context,
  );
  if (runMode === "swe" || runMode === "all") {
    const tabletModule = executionGroups.find((group) =>
      group.deviceSelection.devices.includes("tablet"),
    )?.module;
    context.runs.swe = await withSweTabletCompatibility({
      project: context.workProject,
      module: tabletModule,
      enabled: deviceSelection.devices.includes("tablet"),
      run: () =>
        runCaseExecution(
          input,
          context,
          executionGroups,
          deviceSelection,
          "swe",
        ),
    });
  }

  if (runMode === "answer" || runMode === "all") {
    await applyPatch({
      project: context.workProject,
      patchFile: context.metadata.goldenPatch,
      label: "golden_patch",
      commandExecutor: runPatchCommand,
    });
    context.runs.answer = await runCaseExecution(
      input,
      context,
      executionGroups,
      deviceSelection,
      "answer",
    );
  }
}

async function prepareCaseExecution(
  input: RunCaseInput,
  context: CaseRunContext,
): Promise<{
  executionGroups: PreparedExecutionGroup[];
  deviceSelection: CaseDeviceSelection;
}> {
  const initialModule = firstMappedModule(context.metadata);
  const initialConfig = await loadExecutionConfig({
    project: context.workProject,
    module: initialModule,
    machineConfigPath: input.machineConfigPath,
    testCaseTimeoutMs: context.metadata.testCaseTimeoutMs,
  });
  // 暴露 hvigorw 路径给 cleanupCaseWorkdir，用于关闭 daemon 释放文件锁定。
  context.nodePath = initialConfig.paths.node || "";
  context.hvigorw = initialConfig.paths.hvigorw;
  const deviceSelection = buildCaseDeviceSelection(
    context.metadata,
    initialConfig,
    input.devices,
  );
  const caseGroups = buildCaseExecutionGroups(
    context.metadata,
    deviceSelection,
  );
  const executionGroups: PreparedExecutionGroup[] = [];
  for (const group of caseGroups) {
    const executionConfig =
      group.module === undefined || group.module === initialConfig.module
        ? initialConfig
        : await loadExecutionConfig({
            project: context.workProject,
            module: group.module,
            machineConfigPath: input.machineConfigPath,
            testCaseTimeoutMs: context.metadata.testCaseTimeoutMs,
          });
    executionGroups.push({
      module: group.module,
      executionConfig,
      deviceSelection: group.selection,
    });
  }
  return {
    executionGroups,
    deviceSelection,
  };
}

function firstMappedModule(metadata: CaseMetadata): string | undefined {
  return metadata.deviceHapModules
    ? Object.values(metadata.deviceHapModules)[0]
    : undefined;
}

function loggedPatchCommand(
  input: RunCaseInput,
  context: CaseRunContext,
): (command: string) => Promise<CommandResult> {
  const logged = createLoggedCommandExecutor(
    input.patchCommandExecutor ?? defaultCommandExecutor,
    context.logger,
    context.workProject,
  );
  return (command) => logged(command, context.workProject);
}

function createCaseRunContext(
  input: RunCaseInput,
  startedTime: number,
  outDir: string,
  metadata: CaseMetadata,
  logger: RunnerLogger,
): CaseRunContext {
  return {
    startedTime,
    startedAt: new Date(startedTime).toISOString(),
    metadata,
    outDir,
    out: path.join(outDir, "result.json"),
    workProject: path.join(metadata.caseDir, "work"),
    nodePath: "",
    hvigorw: "",
    diagnostics: [],
    runs: {},
    logger,
  };
}

function resolveOutDir(
  input: RunCaseInput,
  caseDir: string,
  startedTime: number,
): string {
  return path.resolve(
    input.out ??
      path.join(
        caseDir,
        ".ohostest-runs",
        timestampForPath(new Date(startedTime)),
      ),
  );
}

async function runCaseExecution(
  input: RunCaseInput,
  context: CaseRunContext,
  executionGroups: PreparedExecutionGroup[],
  deviceSelection: CaseDeviceSelection,
  phase: "swe" | "answer",
): Promise<NonNullable<CaseResult["runs"]["swe"]>> {
  const outDir = path.join(context.outDir, phase);
  await fs.mkdir(outDir, { recursive: true });
  if (executionGroups.length === 1) {
    const group = executionGroups[0]!;
    const execution = await runPreparedExecutionGroup(
      input,
      context,
      group,
      outDir,
      phase,
    );
    return writeCaseRunResult(outDir, execution);
  }

  const startedTime = Date.now();
  const moduleRuns: CaseModuleRunResult[] = [];
  for (const group of executionGroups) {
    const module = group.module ?? group.executionConfig.module;
    const moduleOutDir = path.join(outDir, "modules", safePathSegment(module));
    await fs.mkdir(moduleOutDir, { recursive: true });
    const execution = await runPreparedExecutionGroup(
      input,
      context,
      group,
      moduleOutDir,
      phase,
    );
    const moduleResult: CaseModuleRunResult = {
      module,
      ...execution,
      artifacts: {
        commandLog: path.relative(moduleOutDir, context.logger.logPath),
        result: "result.json",
        summary: "summary.md",
      },
    };
    await writeModuleRunResult(moduleOutDir, moduleResult);
    moduleRuns.push(moduleResult);
  }

  const devices = sortDevicesBySelection(
    moduleRuns.flatMap((moduleRun) => moduleRun.devices),
    deviceSelection.devices,
  );
  const finishedTime = Date.now();
  const result: NonNullable<CaseResult["runs"]["swe"]> = {
    schemaVersion: "ohostest-matrix-v1",
    project: context.workProject,
    status: deriveExecutionStatus(devices),
    startedAt: new Date(startedTime).toISOString(),
    finishedAt: new Date(finishedTime).toISOString(),
    durationMs: finishedTime - startedTime,
    build: aggregateModuleBuilds(moduleRuns),
    devices,
    diagnostics: moduleRuns.flatMap((moduleRun) =>
      moduleRun.diagnostics.map(
        (diagnostic) => `[${moduleRun.module}] ${diagnostic}`,
      ),
    ),
    module_runs: moduleRuns,
    artifacts: {
      commandLog: "../commands.jsonl",
      summary: "summary.md",
    },
  };
  await writeCaseRunResult(outDir, result);
  return result;
}

async function runPreparedExecutionGroup(
  input: RunCaseInput,
  context: CaseRunContext,
  group: PreparedExecutionGroup,
  outDir: string,
  phase: "swe" | "answer",
): Promise<ExecutionResult> {
  const execution = await runExecution({
    config: group.executionConfig,
    plan: buildExecutionPlan(group.executionConfig, {
      devices: group.deviceSelection.devices,
      suitesByDevice: group.deviceSelection.deviceSuiteOverrides,
      runAllTests: group.deviceSelection.runAllTests,
    }),
    outDir,
    skipBuild: input.skipBuild,
    keepEmulators: input.keepEmulators,
    commandExecutor: input.commandExecutor,
    logger: context.logger.child({
      phase,
      ...(group.module ? { module: group.module } : {}),
    }),
  });
  return execution;
}

async function writeCaseRunResult(
  outDir: string,
  execution: ExecutionResult | NonNullable<CaseResult["runs"]["swe"]>,
): Promise<NonNullable<CaseResult["runs"]["swe"]>> {
  const result: NonNullable<CaseResult["runs"]["swe"]> = {
    schemaVersion: "ohostest-matrix-v1",
    ...execution,
    artifacts: {
      commandLog: "../commands.jsonl",
      summary: "summary.md",
    },
  };
  await fs.writeFile(
    path.join(outDir, "summary.md"),
    renderSummaryMarkdown(result.status, result.devices),
    "utf-8",
  );
  await fs.writeFile(
    path.join(outDir, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf-8",
  );
  return result;
}

async function writeModuleRunResult(
  outDir: string,
  result: CaseModuleRunResult,
): Promise<void> {
  await fs.writeFile(
    path.join(outDir, "summary.md"),
    renderSummaryMarkdown(result.status, result.devices),
    "utf-8",
  );
  await fs.writeFile(
    path.join(outDir, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf-8",
  );
}

function aggregateModuleBuilds(moduleRuns: CaseModuleRunResult[]): BuildResult {
  const representative =
    moduleRuns.find((moduleRun) => moduleRun.build.status === "blocked") ??
    moduleRuns[0];
  if (!representative) {
    throw new Error("case_module_runs_empty");
  }
  return {
    ...representative.build,
    durationMs: moduleRuns.reduce(
      (total, moduleRun) => total + (moduleRun.build.durationMs ?? 0),
      0,
    ),
  };
}

function sortDevicesBySelection(
  devices: ExecutionResult["devices"],
  selectedDeviceIds: string[],
): ExecutionResult["devices"] {
  const order = new Map(
    selectedDeviceIds.map((deviceId, index) => [deviceId, index]),
  );
  return [...devices].sort(
    (left, right) =>
      (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function buildCaseResult(
  input: RunCaseInput,
  context: CaseRunContext,
): CaseResult {
  const status = deriveCaseStatus(context.runs, context.diagnostics);
  const finishedTime = Date.now();
  return {
    schemaVersion: "ohostest-case-v1",
    caseId: context.metadata.caseId,
    caseDir: context.metadata.caseDir,
    baseProject: context.metadata.baseProject,
    startedAt: context.startedAt,
    finishedAt: new Date(finishedTime).toISOString(),
    durationMs: finishedTime - context.startedTime,
    status,
    metadata: metadataForResult(context.metadata),
    runs: context.runs,
    artifacts: buildCaseArtifacts(input, context),
    diagnostics: context.diagnostics,
  };
}

function buildCaseArtifacts(
  input: RunCaseInput,
  context: CaseRunContext,
): CaseResult["artifacts"] {
  return {
    result: relativeToCaseDir(context, context.out),
    summary: relativeToCaseDir(
      context,
      path.join(context.outDir, "summary.md"),
    ),
    commandLog: "commands.jsonl",
    ...(context.runs.swe
      ? {
          sweResult: relativeToCaseDir(
            context,
            path.join(context.outDir, "swe", "result.json"),
          ),
        }
      : {}),
    ...(context.runs.answer
      ? {
          answerResult: relativeToCaseDir(
            context,
            path.join(context.outDir, "answer", "result.json"),
          ),
        }
      : {}),
    ...(input.keepWorkdir ? { workdir: context.workProject } : {}),
  };
}

function failedCaseResult(
  input: RunCaseInput,
  caseDir: string,
  outDir: string,
  startedTime: number,
  error: unknown,
): CaseResult {
  const finishedTime = Date.now();
  const message = formatRunnerError(error);
  return {
    schemaVersion: "ohostest-case-v1",
    caseId: path.basename(caseDir),
    caseDir,
    baseProject: "",
    startedAt: new Date(startedTime).toISOString(),
    finishedAt: new Date(finishedTime).toISOString(),
    durationMs: finishedTime - startedTime,
    status: "failed",
    metadata: {
      testCaseTimeoutMs: 0,
      failToPass: [],
      passToPass: [],
      deviceTestSuites: {},
    },
    runs: {},
    artifacts: {
      result: path.relative(caseDir, path.join(outDir, "result.json")),
      summary: path.relative(caseDir, path.join(outDir, "summary.md")),
      commandLog: "commands.jsonl",
      ...(input.keepWorkdir ? { workdir: path.join(caseDir, "work") } : {}),
    },
    diagnostics: [message],
  };
}

async function writeFailedCaseArtifacts(
  result: CaseResult,
  outDir: string,
): Promise<void> {
  await fs.writeFile(
    path.join(outDir, "summary.md"),
    renderCaseSummary(result),
    "utf-8",
  );
  await fs.writeFile(
    path.join(outDir, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf-8",
  );
}

function relativeToCaseDir(context: CaseRunContext, target: string): string {
  return path.relative(context.metadata.caseDir, target);
}

async function writeCaseArtifacts(
  result: CaseResult,
  context: CaseRunContext,
): Promise<void> {
  await fs.writeFile(
    path.join(context.outDir, "summary.md"),
    renderCaseSummary(result),
    "utf-8",
  );
  await fs.writeFile(
    context.out,
    `${JSON.stringify(result, null, 2)}\n`,
    "utf-8",
  );
}

async function cleanupCaseWorkdir(
  input: RunCaseInput,
  context: CaseRunContext,
  result: CaseResult,
): Promise<void> {
  if (!input.keepWorkdir) {
    try {
      // 先关闭 hvigor daemon，释放其对 work 目录内文件的锁定。
      // 必须在删除目录前执行，否则 Windows 上 fs.rm 会报 EBUSY/resource busy or locked。
      if (context.hvigorw) {
        await stopHvigorDaemon(context.hvigorw, context.workProject, context.nodePath || undefined);
      }
      await removeWithRetry(context.workProject);
    } catch (error) {
      result.diagnostics.push(
        `cleanup_failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await fs.writeFile(
        context.out,
        `${JSON.stringify(result, null, 2)}\n`,
        "utf-8",
      );
    }
  }
}

function timestampForPath(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

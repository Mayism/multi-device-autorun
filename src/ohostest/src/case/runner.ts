import fs from "node:fs/promises";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { readJsonConfigFile } from "../configFile.js";
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
  isPcDeviceId,
  skippedPcDeviceIds,
  loadCaseMetadata,
} from "./config.js";
import { applyPatch } from "./patch.js";
import {
  caseWorkspace,
  prepareCaseWorkspace,
  type CaseWorkspace,
} from "./workspace.js";
import { withWebService } from "./web/service.js";
import { WEB_READY_URL, WEB_SERVER_PORT } from "./web/constants.js";
import {
  applyBundleNameCleanup,
  buildIsolatedBundleNames,
  cleanupTargetsFor,
  readBundleName,
  rewriteBundleName,
} from "./bundleIsolation.js";
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
  CaseRunResult,
  RunCaseInput,
} from "./types/index.js";
import {
  applyAnswerDeviceTypeChecks,
  withCaseDeviceTypeCompatibility,
} from "./deviceCompatibility.js";

interface CaseRunContext extends CaseWorkspace {
  startedTime: number;
  startedAt: string;
  metadata: CaseMetadata;
  outDir: string;
  out: string;
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
  let context: CaseRunContext;
  try {
    metadata = await loadCaseMetadata(bootstrap.caseDir);
    context = createCaseRunContext(
      input,
      bootstrap.startedTime,
      bootstrap.outDir,
      metadata,
      bootstrap.logger,
    );
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
  if (await skipPcOnlyCase(context, runMode)) return;
  const runPatchCommand = loggedPatchCommand(input, context);
  await prepareCaseWorkspace(context.metadata, context);
  await prepareFlutterWorkProject(input, context);
  await applyPatch({
    project: context.patchRoot,
    patchFile: context.metadata.testPatch,
    label: "test_patch",
    commandExecutor: runPatchCommand,
  });

  const isolateBundles = context.metadata.bundleNameIsolation === true;
  const originalBundleName = isolateBundles
    ? await readBundleName(caseHarmonyProject(context))
    : undefined;
  const isolatedNames = originalBundleName
    ? buildIsolatedBundleNames(originalBundleName)
    : undefined;

  let prepared = await prepareCaseExecution(input, context);
  if (isolatedNames && originalBundleName) {
    await rewriteBundleName(caseHarmonyProject(context), isolatedNames.swe);
    prepared = await prepareCaseExecution(input, context);
    applyBundleNameCleanup(
      prepared.executionGroups,
      cleanupTargetsFor(originalBundleName, [isolatedNames.swe]),
    );
  }

  if (runMode === "swe" || runMode === "all") {
    context.runs.swe = await runCasePhase(
      input,
      context,
      prepared.executionGroups,
      prepared.deviceSelection,
      "swe",
    );
  }

  if (runMode === "answer" || runMode === "all") {
    await applyPatch({
      project: context.patchRoot,
      patchFile: context.metadata.goldenPatch,
      label: "golden_patch",
      commandExecutor: runPatchCommand,
    });
    if (context.webProject)
      prepared = await prepareCaseExecution(input, context);
    if (isolatedNames && originalBundleName) {
      const answerBundleName = isolatedNames.answer();
      await rewriteBundleName(caseHarmonyProject(context), answerBundleName);
      prepared = await prepareCaseExecution(input, context);
      applyBundleNameCleanup(
        prepared.executionGroups,
        cleanupTargetsFor(originalBundleName, [answerBundleName]),
      );
    }
    context.runs.answer = await runCasePhase(
      input,
      context,
      prepared.executionGroups,
      prepared.deviceSelection,
      "answer",
    );
  }
}

async function skipPcOnlyCase(
  context: CaseRunContext,
  runMode: "answer" | "swe" | "all",
): Promise<boolean> {
  const skippedDevices = skippedPcDeviceIds(context.metadata);
  if (
    !context.metadata.deviceTestSuites ||
    skippedDevices.length !==
      Object.keys(context.metadata.deviceTestSuites).length
  ) {
    return false;
  }
  await writePcOnlySkippedRuns(context, runMode, skippedDevices);
  return true;
}

async function writePcOnlySkippedRuns(
  context: CaseRunContext,
  runMode: "answer" | "swe" | "all",
  skippedDevices: string[],
): Promise<void> {
  const phases: Array<"swe" | "answer"> =
    runMode === "all" ? ["swe", "answer"] : [runMode];
  for (const phase of phases) {
    const outDir = path.join(context.outDir, phase);
    await fs.mkdir(outDir, { recursive: true });
    const now = new Date().toISOString();
    const result: CaseRunResult = {
      schemaVersion: "ohostest-matrix-v1",
      project: context.metadata.baseProject,
      status: "completed",
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      build: {
        status: "passed",
        appHap: "",
        testHap: "",
        durationMs: 0,
      },
      devices: [],
      diagnostics: [
        `unsupported_pc_device_skipped: ${skippedDevices.join(", ")}`,
      ],
      artifacts: {
        commandLog: "../commands.jsonl",
        summary: "summary.md",
      },
    };
    context.runs[phase] = await writeCaseRunResult(outDir, result);
  }
}

async function runCasePhase(
  input: RunCaseInput,
  context: CaseRunContext,
  executionGroups: PreparedExecutionGroup[],
  deviceSelection: CaseDeviceSelection,
  phase: "swe" | "answer",
): Promise<NonNullable<CaseResult["runs"]["swe"]>> {
  const run = () =>
    runCaseExecution(input, context, executionGroups, deviceSelection, phase);
  if (!context.webProject) return run();
  return withWebService(
    {
      project: context.webProject,
      readyUrl: WEB_READY_URL,
      outDir: context.outDir,
      phase,
      logger: context.logger.child({ phase }),
    },
    run,
  );
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
    ...platformExecutionOptions(context.metadata),
  });
  // 暴露 hvigorw 路径给 cleanupCaseWorkdir，用于关闭 daemon 释放文件锁定。
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
            ...platformExecutionOptions(context.metadata),
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
  if (!metadata.deviceHapModules) return undefined;
  for (const deviceId of Object.keys(metadata.deviceTestSuites ?? {})) {
    if (isPcDeviceId(deviceId)) continue;
    const deploymentType = deviceId === "tablet" ? "tablet" : "phone";
    const module = metadata.deviceHapModules[deploymentType];
    if (module) return module;
  }
  return Object.values(metadata.deviceHapModules)[0];
}

// 平台执行选项：rn/flutter 壳工程重定位的平台标记 + rn 的 bundle 命令覆盖。
function platformExecutionOptions(
  metadata: CaseMetadata,
): { platform?: "rn" | "flutter"; rnBundleCommands?: string[] } {
  const platform = executionPlatform(metadata);
  return {
    ...(platform ? { platform } : {}),
    ...(metadata.rnBuild
      ? { rnBundleCommands: metadata.rnBuild.bundleCommands }
      : {}),
  };
}

// rn 的鸿蒙壳在 workProject/harmony 子目录，flutter 的在 workProject/ohos 子目录；
// 其余平台的壳就是 workProject 本身。
function caseHarmonyProject(context: CaseRunContext): string {
  if (context.metadata.platform === "rn") {
    return path.join(context.workProject, "harmony");
  }
  if (context.metadata.platform === "flutter") {
    return path.join(context.workProject, "ohos");
  }
  return context.workProject;
}

// rn/flutter 的鸿蒙壳位于子目录，由执行层解析构建工程；native/web 的壳就是工程根。
function executionPlatform(
  metadata: CaseMetadata,
): "rn" | "flutter" | undefined {
  return metadata.platform === "rn" || metadata.platform === "flutter"
    ? metadata.platform
    : undefined;
}

function loggedPatchCommand(
  input: RunCaseInput,
  context: CaseRunContext,
): (command: string) => Promise<CommandResult> {
  const logged = createLoggedCommandExecutor(
    input.patchCommandExecutor ?? defaultCommandExecutor,
    context.logger,
    context.patchRoot,
  );
  return (command) => logged(command, context.patchRoot);
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
    ...caseWorkspace(metadata, outDir),
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

// flutter-ohos 工程：base_project 为 Flutter 工程根（pubspec.yaml 与 ohos/ 同级），
// hvigorfile.ts 位于 ohos/ 宿主内而非工程根，鸿蒙壳由执行层解析到 ohos/。
// 复制后仅做文件系统自愈（均不写 context.diagnostics——deriveCaseStatus 将非空
// diagnostics 判为 failed，工程形态识别不是错误；自愈失败由后续构建错误显式暴露）：
// local.properties 由 machine.json paths.flutter 生成（case 不携带本机路径），
// node_modules junction 补齐复制被排除的 flutter-hvigor-plugin；
// flutter pub get 在每轮构建命令中执行（golden_patch 可能新增 Dart 依赖，必须
// 在补丁应用后、hvigor 内 flutter assemble 前刷新 .dart_tool）。
async function prepareFlutterWorkProject(
  input: RunCaseInput,
  context: CaseRunContext,
): Promise<void> {
  const work = context.patchRoot;
  const ohosProject = path.join(work, "ohos");
  const isFlutterLayout =
    !existsSync(path.join(work, "hvigorfile.ts")) &&
    existsSync(path.join(ohosProject, "hvigorfile.ts"));
  if (context.metadata.platform === "flutter" && !isFlutterLayout) {
    throw new Error(
      "case_flutter_project_invalid: flutter platform requires a Flutter project root with an ohos host",
    );
  }
  if (!isFlutterLayout) return;
  if (context.metadata.platform !== "flutter") {
    // 未声明 platform 的 flutter 形态（旧用例）：执行层无法解析壳工程，
    // 直接把构建工程重定向到 ohos/，按原生工程处理。
    context.workProject = ohosProject;
  }
  const flutterSdk = await resolveFlutterSdk(
    input.machineConfigPath,
    ohosProject,
  );
  if (!flutterSdk) return;
  ensureFlutterSdkProperties(ohosProject, flutterSdk);
  ensureFlutterHvigorPlugin(ohosProject, flutterSdk);
}

// flutter-hvigor-plugin 构建期从 ohos/local.properties 读取 flutter.sdk；case 不携带
// 本机绝对路径，SDK 位置优先取 machine.json paths.flutter，其次回退 case 自带值。
async function resolveFlutterSdk(
  machineConfigPath: string | undefined,
  ohosProject: string,
): Promise<string> {
  try {
    const raw = await readJsonConfigFile<{ paths?: { flutter?: string } }>(
      path.resolve(machineConfigPath ?? path.resolve("config", "machine.json")),
    );
    const configured = raw.paths?.flutter?.trim();
    if (configured) return configured;
  } catch {
    // machine 配置不可读时回退 local.properties，最终由构建错误显式暴露
  }
  const properties = await fs
    .readFile(path.join(ohosProject, "local.properties"), "utf8")
    .catch(() => "");
  const match = properties.match(/^flutter\.sdk=(.+)$/m);
  return match ? match[1].trim() : "";
}

function ensureFlutterSdkProperties(
  ohosProject: string,
  flutterSdk: string,
): void {
  const propertiesPath = path.join(ohosProject, "local.properties");
  try {
    const existing = existsSync(propertiesPath)
      ? readFileSync(propertiesPath, "utf8")
      : "";
    if (/^flutter\.sdk=/m.test(existing)) return;
    const lineEnding = existing && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(
      propertiesPath,
      `${existing}${lineEnding}flutter.sdk=${flutterSdk.replace(/\\/g, "/")}\n`,
      "utf8",
    );
  } catch {
    // 写入失败不阻断：若 case 自带完整 local.properties，插件仍可正常解析
  }
}

// .dart_tool 与 flutter 依赖刷新由每轮构建命令中的 `flutter pub get` 完成，
// 此处不重复执行。

// 工程复制排除 node_modules 后，flutter-hvigor-plugin 缺失会使 hvigor 启动即失败；
// 依据 SDK 路径把 SDK 内插件目录以 junction 链入宿主 node_modules。
function ensureFlutterHvigorPlugin(
  ohosProject: string,
  flutterSdk: string,
): void {
  const pluginDir = path.join(
    ohosProject,
    "node_modules",
    "flutter-hvigor-plugin",
  );
  if (existsSync(pluginDir)) return;
  const sdkPlugin = path.join(flutterSdk, "packages", "flutter_tools", "hvigor");
  if (!existsSync(sdkPlugin)) return;
  try {
    mkdirSync(path.dirname(pluginDir), { recursive: true });
    symlinkSync(
      sdkPlugin,
      pluginDir,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch {
    // 链接失败不阻断：由后续构建错误显式暴露
  }
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
    return writeCaseRunResult(outDir, {
      ...execution,
      diagnostics: withSkippedDeviceDiagnostics(
        execution.diagnostics,
        deviceSelection,
      ),
    });
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
    diagnostics: withSkippedDeviceDiagnostics(
      moduleRuns.flatMap((moduleRun) =>
        moduleRun.diagnostics.map(
          (diagnostic) => `[${moduleRun.module}] ${diagnostic}`,
        ),
      ),
      deviceSelection,
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

function withSkippedDeviceDiagnostics(
  diagnostics: string[],
  selection: CaseDeviceSelection,
): string[] {
  return selection.skippedDevices?.length
    ? [
        `unsupported_pc_device_skipped: ${selection.skippedDevices.join(", ")}`,
        ...diagnostics,
      ]
    : diagnostics;
}

async function runPreparedExecutionGroup(
  input: RunCaseInput,
  context: CaseRunContext,
  group: PreparedExecutionGroup,
  outDir: string,
  phase: "swe" | "answer",
): Promise<ExecutionResult> {
  const compatibility = await withCaseDeviceTypeCompatibility({
    project: group.executionConfig.project,
    module: group.module,
    deviceIds: group.deviceSelection.devices,
    run: () =>
      runExecution({
        config: group.executionConfig,
        plan: buildExecutionPlan(group.executionConfig, {
          devices: group.deviceSelection.devices,
          suitesByDevice: group.deviceSelection.deviceSuiteOverrides,
          runAllTests: group.deviceSelection.runAllTests,
        }),
        outDir,
        skipBuild: input.skipBuild,
        keepEmulators: input.keepEmulators,
        webServerPort: context.webProject ? WEB_SERVER_PORT : undefined,
        commandExecutor: input.commandExecutor,
        logger: context.logger.child({
          phase,
          ...(group.module ? { module: group.module } : {}),
        }),
      }),
  });
  return phase === "answer"
    ? applyAnswerDeviceTypeChecks(compatibility.value, compatibility.assessment)
    : compatibility.value;
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
    ...(input.keepWorkdir ? { workdir: context.patchRoot } : {}),
    ...(context.webProject
      ? {
          webLogs: relativeToCaseDir(context, path.join(context.outDir, "web")),
        }
      : {}),
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
      ...(input.keepWorkdir
        ? { workdir: path.join(outDir, "work", "project") }
        : {}),
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
        await stopHvigorDaemon(context.hvigorw, caseHarmonyProject(context));
      }
      await removeWithRetry(path.join(context.outDir, "work"));
    } catch (error) {
      const message = `cleanup_failed: ${error instanceof Error ? error.message : String(error)}`;
      console.warn(
        `提示：临时工作目录未完全删除，已保留剩余文件。本次测试结果已保存，不受此次目录清理影响；后续可使用新的输出目录继续测试。\n残留目录：${path.join(context.outDir, "work")}\n清理详情：${context.out}（diagnostics）`,
      );
      result.diagnostics.push(message);
      await fs.writeFile(
        context.out,
        `${JSON.stringify(result, null, 2)}\n`,
        "utf-8",
      );
    }
  }
}

function timestampForPath(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

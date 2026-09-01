import path from "node:path";
import { defaultCommandExecutor, runDetachedCommand } from "./command.js";
import { sleep } from "./utils/sleep.js";
import { buildTestHapCommand, runBuild } from "./build.js";
import {
  buildEmulatorProcessQueryCommand,
  buildStartEmulatorCommand,
  buildStopEmulatorCommand,
  installHaps,
  isEmulatorProcessListed,
  prepareDevice,
  waitForTargetDisconnected,
} from "./device.js";
import { buildAaTestCommand, parseAaTestOutput } from "./ohostest.js";
import { deriveExecutionStatus } from "./result.js";
import {
  deployFoldTrigger,
  startManagedFoldServer,
  stopManagedFoldServer,
} from "../fold/server.js";
import type { FoldServerInstance } from "../fold/server.js";
import { createLoggedCommandExecutor } from "../logging/command.js";
import type { RunnerLogger } from "../logging/logger.js";
import type {
  CommandResult,
  DeviceRunResult,
  InstallArtifacts,
  ExecutionConfig,
  ExecutionResult,
  ParsedAaTestOutput,
  RunExecutionInput,
  SuiteRunResult,
} from "./types/index.js";

const emulatorRestartCooldownMs = 5000;
const screenUnlockSettleMs = 1000;

interface ExecutionRunContext {
  startedTime: number;
  startedAt: string;
  config: ExecutionConfig;
  selectedDevices: ExecutionConfig["devices"];
  outDir: string;
  commandLog: string;
  diagnostics: string[];
  logger: RunnerLogger;
  executor: NonNullable<RunExecutionInput["commandExecutor"]>;
  runCommand: (command: string) => Promise<CommandResult>;
  runDetached: (command: string) => Promise<CommandResult>;
}

interface DeviceRunInput {
  config: ExecutionConfig;
  installArtifacts: InstallArtifacts;
  device: ExecutionConfig["devices"][number];
  outDir: string;
  commandLog: string;
  keepEmulators: boolean;
  logger: RunnerLogger;
  executor: NonNullable<RunExecutionInput["commandExecutor"]>;
  runCommand: (command: string) => Promise<CommandResult>;
  runDetached: (command: string) => Promise<CommandResult>;
}

type TestRunInput = Pick<
  DeviceRunInput,
  "config" | "device" | "executor" | "logger"
>;

const aaTestHostTimeoutGraceMs = 30000;

interface LoggedTestRun {
  commandResult: CommandResult;
  parsed: ParsedAaTestOutput;
  logger: RunnerLogger;
}

export async function runExecution(
  input: RunExecutionInput,
): Promise<ExecutionResult> {
  const context = await createExecutionRunContext(input);

  await deployDefaultFoldTriggerIfNeeded(context);

  const buildOutcome = await runBuild({
    config: context.config,
    skipBuild: input.skipBuild ?? false,
    runCommand: context.runCommand,
    diagnostics: context.diagnostics,
  });
  if (buildOutcome.result.status === "blocked") {
    context.logger.recordError(
      new Error(buildOutcome.result.blockedReason ?? "build_blocked"),
      { errorCode: "BUILD_BLOCKED" },
    );
  }

  const devices =
    buildOutcome.result.status === "passed" && buildOutcome.installArtifacts
      ? await runSelectedDevices(context, input, buildOutcome.installArtifacts)
      : [];

  const status = deriveExecutionStatus(devices);
  const result = buildExecutionResult(
    context,
    buildOutcome.result,
    devices,
    status,
  );
  return result;
}

async function createExecutionRunContext(
  input: RunExecutionInput,
): Promise<ExecutionRunContext> {
  const startedTime = Date.now();
  const config = input.config;
  const selectedDevices = input.plan.devices;
  const outDir = path.resolve(input.outDir);
  const executor = input.commandExecutor ?? defaultCommandExecutor;
  const detachedExecutor = (command: string, cwd: string) =>
    runDetachedCommand(command, cwd);

  return {
    startedTime,
    startedAt: new Date(startedTime).toISOString(),
    config,
    selectedDevices,
    outDir,
    commandLog: path.relative(outDir, input.logger.logPath),
    diagnostics: [],
    logger: input.logger,
    executor,
    runCommand: bindLoggedCommandExecutor(
      executor,
      input.logger,
      config.project,
    ),
    runDetached: bindLoggedCommandExecutor(
      detachedExecutor,
      input.logger,
      config.project,
    ),
  };
}

async function deployDefaultFoldTriggerIfNeeded(
  context: ExecutionRunContext,
): Promise<void> {
  if (context.selectedDevices.some((device) => device.foldControl)) {
    await deployFoldTrigger(
      context.config.project,
      8765,
      context.config.moduleSrcPath,
    );
  }
}

async function runSelectedDevices(
  context: ExecutionRunContext,
  input: RunExecutionInput,
  installArtifacts: InstallArtifacts,
): Promise<DeviceRunResult[]> {
  const devices: DeviceRunResult[] = [];
  for (let index = 0; index < context.selectedDevices.length; index += 1) {
    const device = context.selectedDevices[index];
    const logger = context.logger.child({ deviceId: device.id });
    devices.push(
      await runDevice({
        config: context.config,
        outDir: context.outDir,
        commandLog: context.commandLog,
        device,
        installArtifacts,
        keepEmulators: input.keepEmulators ?? false,
        logger,
        executor: context.executor,
        runCommand: bindLoggedCommandExecutor(
          context.executor,
          logger,
          context.config.project,
        ),
        runDetached: bindLoggedCommandExecutor(
          (command, cwd) => runDetachedCommand(command, cwd),
          logger,
          context.config.project,
        ),
      }),
    );
    if (
      shouldWaitBeforeNextEmulatorStart(
        context.selectedDevices,
        index,
        input.keepEmulators ?? false,
      )
    ) {
      await sleep(emulatorRestartCooldownMs);
    }
  }
  return devices;
}

function buildExecutionResult(
  context: ExecutionRunContext,
  build: ExecutionResult["build"],
  devices: DeviceRunResult[],
  status: ExecutionResult["status"],
): ExecutionResult {
  const finishedTime = Date.now();
  return {
    project: context.config.project,
    status,
    startedAt: context.startedAt,
    finishedAt: new Date(finishedTime).toISOString(),
    durationMs: finishedTime - context.startedTime,
    build,
    devices,
    diagnostics: context.diagnostics,
  };
}

function shouldWaitBeforeNextEmulatorStart(
  devices: ExecutionConfig["devices"],
  currentIndex: number,
  keepEmulators: boolean,
): boolean {
  return (
    !keepEmulators &&
    devices[currentIndex]?.startEmulator === true &&
    devices.slice(currentIndex + 1).some((device) => device.startEmulator)
  );
}

async function runDevice(input: DeviceRunInput): Promise<DeviceRunResult> {
  const started = Date.now();
  let foldServer: FoldServerInstance | undefined;
  let result: DeviceRunResult;

  try {
    const emulatorBlock = await startEmulatorIfNeeded(input, started);
    if (emulatorBlock) {
      result = emulatorBlock;
    } else {
      await prepareRunDevice(input);
      const foldResult = await startFoldSupportIfNeeded(input, started);
      if (foldResult.blocked) {
        result = foldResult.blocked;
      } else {
        foldServer = foldResult.foldServer;
        if (foldServer) await deployDeviceFoldTrigger(input, foldServer);
        await installRunHaps(input);
        const suiteResults = await runDeviceSuites(input, started);
        result = isBlockedDeviceResult(suiteResults)
          ? suiteResults
          : passedDevice(input, started, suiteResults, foldServer);
      }
    }
  } catch (error) {
    const reason = reasonFromError(error);
    result = reason === "test_command_timed_out"
      ? timedOutDevice(input, started)
      : blockedDevice(input, started, reason);
  }
  const foldCleanupFailed = await cleanupRunDevice(input, foldServer);
  return foldCleanupFailed ? applyFoldCleanupFailure(result) : result;
}

// start 命令经 cmd start 包装后，Emulator.exe 启动即退不会反映到退出码（恒为 0）。
// 启动后先探测进程是否真的出现，把"没起来"（emulator_start_failed，快速失败）
// 和"起来了但 target 未连接"（hdc_not_connected，走原有 120 轮等待）区分开。
const emulatorStartDetectMs = 15000;
const emulatorStartDetectIntervalMs = 2000;
const emulatorStartRetryDelayMs = 5000;
const emulatorStartMaxAttempts = 2;

async function startEmulatorIfNeeded(
  input: DeviceRunInput,
  started: number,
): Promise<DeviceRunResult | undefined> {
  if (!input.device.startEmulator) return undefined;
  for (let attempt = 1; attempt <= emulatorStartMaxAttempts; attempt += 1) {
    const start = await input.runDetached(
      buildStartEmulatorCommand(input.config, input.device),
    );
    if (start.exitCode !== 0) {
      return blockedDevice(input, started, "emulator_start_failed");
    }
    if (await waitForEmulatorProcess(input)) return undefined;
    // 偶发的实例状态抖动会导致启动即退：延迟后自动重试一次
    if (attempt < emulatorStartMaxAttempts) {
      await sleep(emulatorStartRetryDelayMs);
    }
  }
  return blockedDevice(input, started, "emulator_start_failed");
}

async function waitForEmulatorProcess(
  input: DeviceRunInput,
): Promise<boolean> {
  const query = buildEmulatorProcessQueryCommand();
  // 平台不支持进程探测时（如 linux），维持原有的纯 target 等待行为
  if (!query) return true;
  const deadline = Date.now() + emulatorStartDetectMs;
  while (Date.now() < deadline) {
    const result = await input.executor(query, input.config.project);
    if (isEmulatorProcessListed(result.stdout)) return true;
    await sleep(emulatorStartDetectIntervalMs);
  }
  return false;
}

async function prepareRunDevice(input: DeviceRunInput): Promise<void> {
  await prepareDevice({
    config: input.config,
    device: input.device,
    cwd: input.config.project,
    outDir: input.outDir,
    runCommand: input.runCommand,
    pollCommand: (command) => input.executor(command, input.config.project),
    logger: input.logger,
  });
}

async function startFoldSupportIfNeeded(
  input: DeviceRunInput,
  started: number,
): Promise<{ foldServer?: FoldServerInstance; blocked?: DeviceRunResult }> {
  if (!input.device.foldControl || !input.config.paths.foldServerScript) {
    return {};
  }
  try {
    const foldServer = await startManagedFoldServer({
      device: input.device,
      foldServerScript: input.config.paths.foldServerScript,
      hdc: input.config.paths.hdc,
      runCommand: input.runCommand,
    });
    return { foldServer };
  } catch (error) {
    const blockedReason =
      error instanceof Error && error.message.includes("fold_cleanup_failed")
        ? "fold_cleanup_failed"
        : "fold_server_start_failed";
    return {
      blocked: blockedDevice(input, started, blockedReason),
    };
  }
}

async function deployDeviceFoldTrigger(
  input: DeviceRunInput,
  foldServer: FoldServerInstance,
): Promise<void> {
  await deployFoldTrigger(
    input.config.project,
    foldServer.devicePort,
    input.config.moduleSrcPath,
  );
  await input.runCommand(buildTestHapCommand(input.config));
}

async function installRunHaps(input: DeviceRunInput): Promise<void> {
  await installHaps(
    {
      config: input.config,
      device: input.device,
      cwd: input.config.project,
      outDir: input.outDir,
      runCommand: input.runCommand,
    },
    input.installArtifacts,
  );
}

async function runDeviceSuites(
  input: DeviceRunInput,
  started: number,
): Promise<SuiteRunResult[] | DeviceRunResult> {
  const suiteClasses = selectedSuiteClasses(input);
  if (suiteClasses.length === 0) {
    return runAllSuites(input, started);
  }

  const suiteResults: SuiteRunResult[] = [];
  for (const suiteClass of suiteClasses) {
    suiteResults.push(await runSuite({ ...input, suiteClass }));
  }
  return suiteResults;
}

function selectedSuiteClasses(input: DeviceRunInput): string[] {
  if (input.config.testClass) {
    return [input.config.testClass];
  }
  return input.device.testClasses && input.device.testClasses.length > 0
    ? input.device.testClasses
    : [];
}

async function runAllSuites(
  input: DeviceRunInput,
  started: number,
): Promise<SuiteRunResult[] | DeviceRunResult> {
  const testRun = await runLoggedTestWithUnlockRetry(input, "ALL");
  if (testRun.commandResult.exitCode !== 0) {
    return blockedDevice(input, started, "test_command_failed");
  }
  if (!testRun.parsed.ok && testRun.parsed.blockedReason) {
    return blockedDevice(input, started, testRun.parsed.blockedReason);
  }
  const result = suiteResultFromParsed("ALL", testRun.parsed);
  testRun.logger.recordTestSuite(result);
  return [result];
}

function isBlockedDeviceResult(
  result: SuiteRunResult[] | DeviceRunResult,
): result is DeviceRunResult {
  return !Array.isArray(result);
}

function passedDevice(
  input: DeviceRunInput,
  started: number,
  suiteResults: SuiteRunResult[],
  foldServer?: FoldServerInstance,
): DeviceRunResult {
  const aggregate = aggregateSuites(suiteResults);
  return {
    id: input.device.id,
    ...(input.device.profile ? { profile: input.device.profile } : {}),
    target: input.device.target,
    status: suiteResults.some((suite) => suite.status !== "passed")
      ? "failed"
      : "passed",
    testsRun: aggregate.testsRun,
    failures: aggregate.failures,
    errors: aggregate.errors,
    passes: aggregate.passes,
    ignored: aggregate.ignored,
    suiteResults,
    durationMs: Date.now() - started,
    log: input.commandLog,
    ...(foldServer ? { foldServerPort: foldServer.port } : {}),
  };
}

async function cleanupRunDevice(
  input: DeviceRunInput,
  foldServer: FoldServerInstance | undefined,
): Promise<boolean> {
  let foldCleanupFailed = false;
  if (foldServer) {
    const cleanup = await stopManagedFoldServer({
      instance: foldServer,
      hdc: input.config.paths.hdc,
      runCommand: input.runCommand,
    });
    if (!cleanup.ok) {
      foldCleanupFailed = true;
      input.logger.recordError(new Error(cleanup.diagnostics.join("; ")), {
        errorCode: "FOLD_CLEANUP_FAILED",
      });
    }
  }
  if (!input.device.startEmulator || input.keepEmulators) {
    return foldCleanupFailed;
  }
  await input.runDetached(buildStopEmulatorCommand(input.config, input.device));
  await waitForTargetDisconnected({
    config: input.config,
    device: input.device,
    cwd: input.config.project,
    outDir: input.outDir,
    runCommand: input.runCommand,
    pollCommand: (command) => input.executor(command, input.config.project),
    logger: input.logger,
  });
  return foldCleanupFailed;
}

function blockedDevice(
  input: Pick<DeviceRunInput, "device" | "logger" | "commandLog">,
  started: number,
  blockedReason: DeviceRunResult["blockedReason"],
): DeviceRunResult {
  input.logger.recordError(new Error(blockedReason ?? "device_blocked"), {
    errorCode: blockedReason?.toUpperCase(),
  });
  return {
    id: input.device.id,
    ...(input.device.profile ? { profile: input.device.profile } : {}),
    target: input.device.target,
    status: "blocked",
    testsRun: 0,
    failures: 0,
    errors: 0,
    passes: 0,
    ignored: 0,
    suiteResults: [],
    durationMs: Date.now() - started,
    log: input.commandLog,
    blockedReason,
  };
}

async function runSuite(
  input: DeviceRunInput & { suiteClass: string },
): Promise<SuiteRunResult> {
  const testRun = await runLoggedTestWithUnlockRetry(
    input,
    input.suiteClass,
    input.suiteClass,
  );
  let result: SuiteRunResult;
  if (testRun.commandResult.exitCode !== 0) {
    result = emptySuiteResult(input.suiteClass, "failed");
  } else if (!testRun.parsed.ok && testRun.parsed.blockedReason) {
    result = emptySuiteResult(input.suiteClass, "blocked");
  } else {
    result = suiteResultFromParsed(input.suiteClass, testRun.parsed);
  }
  testRun.logger.recordTestSuite(result);
  return result;
}

async function runLoggedTestWithUnlockRetry(
  input: DeviceRunInput,
  suiteClass: string,
  testClass?: string,
): Promise<LoggedTestRun> {
  let testRun = await runLoggedTest(input, suiteClass, testClass);
  if (!isRetriableTestLaunchResult(testRun.commandResult)) {
    return testRun;
  }
  await prepareRunDevice(input);
  await sleep(screenUnlockSettleMs);
  testRun = await runLoggedTest(input, suiteClass, testClass);
  return testRun;
}

export function isRetriableTestLaunchResult(result: CommandResult): boolean {
  return /10106102|device screen is locked|unlock screen failed|TestAbility onDestroy unexpectedly|Can not connect to AAMS/i.test(
    `${result.stdout}\n${result.stderr}`,
  );
}

async function runLoggedTest(
  input: TestRunInput,
  suiteClass: string,
  testClass?: string,
): Promise<LoggedTestRun> {
  const logger = input.logger.child({ suiteClass });
  const command = buildTestCommand(input.config, input.device, testClass);
  let commandResult: CommandResult;
  try {
    commandResult = await input.executor(command, input.config.project, {
      timeoutMs: input.config.timeoutMs + aaTestHostTimeoutGraceMs,
    });
  } catch (error) {
    logger.recordError(error, { command });
    throw error;
  }
  if (commandResult.timedOut) {
    logger.recordCommand(command, commandResult);
    logger.recordError(new Error("test_command_timed_out"), {
      command,
      errorCode: "TEST_COMMAND_TIMED_OUT",
    });
    throw new Error("test_command_timed_out");
  }
  const parsed = parseAaTestOutput(
    `${commandResult.stdout}\n${commandResult.stderr}`,
  );
  logger.recordCommand(
    command,
    parsed.testsRun === undefined
      ? commandResult
      : { ...commandResult, stdout: "" },
  );
  for (const testCase of parsed.testCases ?? []) {
    logger.recordTestCase(testCase);
  }
  return { commandResult, parsed, logger };
}

function bindLoggedCommandExecutor(
  executor: NonNullable<RunExecutionInput["commandExecutor"]>,
  logger: RunnerLogger,
  cwd: string,
): (command: string) => Promise<CommandResult> {
  const logged = createLoggedCommandExecutor(executor, logger, cwd);
  return (command) => logged(command, cwd);
}

function emptySuiteResult(
  suiteClass: string,
  status: SuiteRunResult["status"],
): SuiteRunResult {
  return {
    suiteClass,
    status,
    testsRun: 0,
    failures: 0,
    errors: 1,
    passes: 0,
    ignored: 0,
    reportCode: null,
    ok: false,
    testCases: [],
  };
}

function suiteResultFromParsed(
  suiteClass: string,
  parsed: ReturnType<typeof parseAaTestOutput>,
): SuiteRunResult {
  return {
    suiteClass,
    status: parsed.ok ? "passed" : "failed",
    testsRun: parsed.testsRun ?? 0,
    failures: parsed.failures ?? 0,
    errors: parsed.errors ?? 0,
    passes: parsed.passes ?? 0,
    ignored: parsed.ignored ?? 0,
    reportCode: parsed.reportCode ?? null,
    ok: parsed.ok,
    testCases: parsed.testCases ?? [],
  };
}

function buildTestCommand(
  config: ExecutionConfig,
  device: ExecutionConfig["devices"][number],
  testClass?: string,
): string {
  return buildAaTestCommand({
    hdc: config.paths.hdc,
    target: device.target,
    bundleName: config.bundleName,
    testModule: config.testModule,
    testRunner: config.testRunner,
    testCaseTimeoutMs: config.testCaseTimeoutMs,
    timeoutMs: config.timeoutMs,
    ...(testClass ? { testClass } : {}),
  });
}

function aggregateSuites(
  suiteResults: SuiteRunResult[],
): Pick<
  SuiteRunResult,
  "testsRun" | "failures" | "errors" | "passes" | "ignored"
> {
  return suiteResults.reduce(
    (aggregate, suite) => ({
      testsRun: aggregate.testsRun + suite.testsRun,
      failures: aggregate.failures + suite.failures,
      errors: aggregate.errors + suite.errors,
      passes: aggregate.passes + suite.passes,
      ignored: aggregate.ignored + suite.ignored,
    }),
    { testsRun: 0, failures: 0, errors: 0, passes: 0, ignored: 0 },
  );
}

function reasonFromError(error: unknown): DeviceRunResult["blockedReason"] {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("test_command_timed_out")) {
    return "test_command_timed_out";
  }
  if (message.includes("device_unlock_failed")) {
    return "device_unlock_failed";
  }
  if (message.includes("install_failed")) {
    return "install_failed";
  }
  if (message.includes("hdc_not_connected")) {
    return "hdc_not_connected";
  }
  if (message.includes("test_output_unparseable")) {
    return "test_output_unparseable";
  }
  if (message.includes("fold_cleanup_failed")) {
    return "fold_cleanup_failed";
  }
  return "test_command_failed";
}

function timedOutDevice(
  input: Pick<DeviceRunInput, "device" | "commandLog">,
  started: number,
): DeviceRunResult {
  return {
    id: input.device.id,
    ...(input.device.profile ? { profile: input.device.profile } : {}),
    target: input.device.target,
    status: "timed_out",
    testsRun: 0,
    failures: 0,
    errors: 0,
    passes: 0,
    ignored: 0,
    suiteResults: [],
    durationMs: Date.now() - started,
    log: input.commandLog,
    blockedReason: "test_command_timed_out",
  };
}

export function applyFoldCleanupFailure(
  result: DeviceRunResult,
): DeviceRunResult {
  return {
    ...result,
    status: "blocked",
    blockedReason: "fold_cleanup_failed",
  };
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut?: boolean;
}

export interface CommandExecutionOptions {
  timeoutMs?: number;
}

export type CommandExecutor = (
  command: string,
  cwd: string,
  options?: CommandExecutionOptions,
) => Promise<CommandResult>;

export type ExecutionStatus = "completed" | "failed";

export type DeviceRunStatus = "passed" | "failed" | "blocked" | "timed_out";

export type BlockedReason =
  | "emulator_start_failed"
  | "hdc_not_connected"
  | "install_failed"
  | "test_command_failed"
  | "test_command_timed_out"
  | "test_output_unparseable"
  | "fold_server_start_failed"
  | "device_unlock_failed"
  | "fold_cleanup_failed"
  | "web_forward_failed"
  | "web_forward_cleanup_failed";

export interface RawExecutionConfig {
  product?: string;
  module?: string;
  bundleName?: string;
  testModule?: string;
  testRunner?: string;
  testClass?: string;
  timeoutMs?: number;
  build?: {
    mode?: string;
    appTask?: string;
    testTask?: string;
  };
  paths?: {
    hvigorw?: string;
    ohpm?: string;
    npm?: string;
    flutter?: string;
    hdc?: string;
    emulatorBin?: string;
    emulatorDeployedDir?: string;
    foldServerScript?: string;
  };
  artifacts?: {
    appHap?: string;
    testHap?: string;
  };
  devices?: RawDeviceConfig[];
}

export interface RawDeviceConfig {
  id?: string;
  profile?: string;
  target?: string;
  hdcPort?: number;
  bootMode?: string;
  startEmulator?: boolean;
  foldControl?: boolean;
  testSuites?: unknown;
}

export interface BundleNameCleanup {
  prefixes: string[];
  keep: string[];
}

export interface ExecutionConfig {
  project: string;
  product: string;
  module: string;
  moduleSrcPath: string;
  sharedModules: SharedModuleInfo[];
  bundleName: string;
  bundleNameCleanup?: BundleNameCleanup;
  testModule: string;
  testRunner: string;
  testClass?: string;
  testCaseTimeoutMs: number;
  timeoutMs: number;
  build: {
    mode: string;
    appTask: string;
    testTask: string;
  };
  rn?: {
    root: string;
    bundleCommands?: string[];
  };
  flutter?: {
    root: string;
  };
  paths: {
    hvigorw: string;
    ohpm: string;
    npm?: string;
    flutter?: string;
    hdc: string;
    emulatorBin: string;
    emulatorDeployedDir: string;
    foldServerScript?: string;
  };
  artifacts: {
    appHap: string;
    testHap: string;
  };
  devices: DeviceConfig[];
}

export interface SharedModuleInfo {
  name: string;
  srcPath: string;
  outputDir: string;
  packageName: string;
  dependencies: string[];
}

export interface DeviceConfig {
  id: string;
  profile?: string;
  target: string;
  hdcPort?: number;
  bootMode?: "coldboot" | "reset" | "snapshot";
  startEmulator: boolean;
  foldControl?: boolean;
  testClasses?: string[];
}

export interface ExecutionPlan {
  devices: DeviceConfig[];
}

export interface ParsedAaTestOutput {
  ok: boolean;
  testsRun?: number;
  failures?: number;
  errors?: number;
  passes?: number;
  ignored?: number;
  reportCode?: number;
  testCases?: TestCaseRunResult[];
  blockedReason?: BlockedReason;
}

export interface BuildResult {
  status: "passed" | "blocked";
  appHap: string;
  testHap: string;
  durationMs?: number;
  blockedReason?: string;
}

export interface BuildCommand {
  command: string;
  cwd: string;
}

export interface InstallArtifacts {
  hspPaths: string[];
  appHap: string;
  testHap: string;
}

export interface BuildOutcome {
  result: BuildResult;
  installArtifacts?: InstallArtifacts;
}

export type SuiteRunStatus = "passed" | "failed" | "blocked";

export type TestCaseRunStatus = "passed" | "failed" | "ignored" | "running";

export interface TestCaseRunResult {
  name: string;
  status: TestCaseRunStatus;
  statusCode: number;
  durationMs?: number;
  message?: string;
  stack?: string;
}

export interface SuiteRunResult {
  suiteClass: string;
  status: SuiteRunStatus;
  testsRun: number;
  failures: number;
  errors: number;
  passes: number;
  ignored: number;
  reportCode: number | null;
  ok: boolean;
  testCases: TestCaseRunResult[];
  outputFile?: string;
}

export interface DeviceRunResult {
  id: string;
  profile?: string;
  target: string;
  status: DeviceRunStatus;
  testsRun: number;
  failures: number;
  errors: number;
  passes: number;
  ignored: number;
  reportCode?: number;
  suiteResults: SuiteRunResult[];
  durationMs: number;
  log: string;
  blockedReason?: BlockedReason;
  foldServerPort?: number;
}

export interface ExecutionResult {
  project: string;
  status: ExecutionStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  build: BuildResult;
  devices: DeviceRunResult[];
  diagnostics: string[];
}

export interface RunExecutionInput {
  config: ExecutionConfig;
  plan: ExecutionPlan;
  outDir: string;
  skipBuild?: boolean;
  keepEmulators?: boolean;
  /** Case-owned Web service port; forwarded from each selected device. */
  webServerPort?: number;
  commandExecutor?: CommandExecutor;
  logger: import("../../logging/logger.js").RunnerLogger;
}

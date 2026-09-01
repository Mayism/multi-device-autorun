export type {
  BlockedReason,
  BuildOutcome,
  BuildResult,
  CommandExecutor,
  CommandResult,
  DeviceConfig,
  DeviceRunResult,
  DeviceRunStatus,
  InstallArtifacts,
  ParsedAaTestOutput,
  RawDeviceConfig,
  SharedModuleInfo,
  SuiteRunResult,
  SuiteRunStatus,
  TestCaseRunResult,
  TestCaseRunStatus,
} from "../../execution/types/index.js";

import type {
  CommandExecutor,
  ExecutionConfig,
  ExecutionResult,
} from "../../execution/types/index.js";

export type MatrixConfig = ExecutionConfig;
export type RawMatrixConfig =
  import("../../execution/types/index.js").RawExecutionConfig;
export type MatrixStatus =
  import("../../execution/types/index.js").ExecutionStatus;

export interface MatrixResult extends ExecutionResult {
  schemaVersion: "ohostest-matrix-v1";
  artifacts: {
    commandLog: string;
    summary: string;
  };
}

export interface RunMatrixInput {
  project: string;
  machineConfigPath?: string;
  out?: string;
  devices?: string[];
  testClass?: string;
  skipBuild?: boolean;
  keepEmulators?: boolean;
  testCaseTimeoutMs?: number;
  commandExecutor?: CommandExecutor;
}

import type { CommandExecutor } from "../../execution/types/index.js";
import type { ExecutionResult } from "../../execution/types/index.js";

export type CaseRunMode = "answer" | "swe" | "all";

export interface RunCaseInput {
  caseDir: string;
  devices?: string[];
  machineConfigPath?: string;
  out?: string;
  runMode?: CaseRunMode;
  skipBuild?: boolean;
  keepEmulators?: boolean;
  keepWorkdir?: boolean;
  commandExecutor?: CommandExecutor;
  patchCommandExecutor?: CommandExecutor;
}

export interface CaseDeviceSuite {
  suite: string;
  file?: string;
}

export type DeviceDeploymentType = "phone" | "tablet" | "pc";

export type DeviceHapModules = Partial<Record<DeviceDeploymentType, string>>;

export interface CaseMetadata {
  caseId: string;
  caseDir: string;
  baseProject: string;
  testPatch: string;
  goldenPatch: string;
  testCaseTimeoutMs: number;
  failToPass: string[];
  passToPass: string[];
  deviceTestSuites?: Record<string, CaseDeviceSuite[]>;
  enabledDevices?: string[];
  deviceHapModules?: DeviceHapModules;
}

export interface CaseDeviceSelection {
  devices: string[];
  deviceSuiteOverrides?: Record<string, string[]>;
  runAllTests: boolean;
}

export interface CaseExecutionGroup {
  module?: string;
  selection: CaseDeviceSelection;
}

export type CaseStatus = "completed" | "failed";

export interface CaseRunResult extends ExecutionResult {
  schemaVersion: "ohostest-matrix-v1";
  module_runs?: CaseModuleRunResult[];
  artifacts: {
    commandLog: string;
    summary: string;
  };
}

export interface CaseModuleRunResult extends ExecutionResult {
  module: string;
  artifacts: {
    commandLog: string;
    result: string;
    summary: string;
  };
}

export interface CaseResult {
  schemaVersion: "ohostest-case-v1";
  caseId: string;
  caseDir: string;
  baseProject: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: CaseStatus;
  metadata: {
    testCaseTimeoutMs: number;
    failToPass: string[];
    passToPass: string[];
    deviceTestSuites: Record<string, CaseDeviceSuite[]>;
    enabledDevices?: string[];
    deviceHapModules?: DeviceHapModules;
  };
  runs: {
    swe?: CaseRunResult;
    answer?: CaseRunResult;
  };
  artifacts: {
    result: string;
    summary: string;
    commandLog: string;
    sweResult?: string;
    answerResult?: string;
    workdir?: string;
  };
  diagnostics: string[];
}

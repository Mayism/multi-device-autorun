import path from "node:path";
import { configFileError, readJsonConfigFile } from "../configFile.js";
import type { ExecutionConfig, RawExecutionConfig } from "./types/index.js";
import { AA_TEST_CASE_TIMEOUT_MS } from "./ohostest.js";
import { discoverProjectInfo } from "./project/discovery.js";

export interface LoadExecutionConfigInput {
  project: string;
  module?: string;
  machineConfigPath?: string;
  testClass?: string;
  testCaseTimeoutMs?: number;
}

export async function loadExecutionConfig(
  input: LoadExecutionConfigInput,
): Promise<ExecutionConfig> {
  const project = path.resolve(input.project);
  const machineConfigPath = path.resolve(
    input.machineConfigPath ?? defaultMachineConfigPath(),
  );
  const raw = await readJsonConfigFile<RawExecutionConfig>(machineConfigPath);
  const requestedModule = input.module ?? raw.module;
  const projectInfo = await discoverProjectInfo(project, requestedModule);
  try {
    validateRawConfig(raw);

    const paths = readToolPaths(raw.paths);
    const devices = readDevices(raw);
    validateFoldControl(devices, paths);

    return buildExecutionConfig({
      project,
      raw,
      projectInfo,
      paths,
      devices,
      input,
    });
  } catch (error) {
    throw configFileError(machineConfigPath, error);
  }
}

function validateRawConfig(raw: RawExecutionConfig): void {
  if (!raw.devices || raw.devices.length === 0) {
    throw new Error("config.devices must contain at least one device.");
  }
  if (hasOwn(raw, "testFolders")) {
    throw new Error(
      "config.testFolders has been removed. Put suite class names in config.devices[].testSuites.",
    );
  }
}

function readDevices(raw: RawExecutionConfig): ExecutionConfig["devices"] {
  return raw.devices?.map((device, index) => readDevice(device, index)) ?? [];
}

function readDevice(
  device: NonNullable<RawExecutionConfig["devices"]>[number],
  index: number,
): ExecutionConfig["devices"][number] {
  validateRawDevice(device, index);
  const testClasses = readDeviceTestSuites(device.testSuites, index);

  return {
    id: device.id,
    ...(device.profile ? { profile: device.profile } : {}),
    target: device.target,
    ...(device.hdcPort !== undefined
      ? { hdcPort: readHdcPort(device.hdcPort, index) }
      : {}),
    startEmulator: device.startEmulator ?? false,
    foldControl: device.foldControl ?? false,
    ...(testClasses.length > 0 ? { testClasses } : {}),
  };
}

function validateRawDevice(
  device: NonNullable<RawExecutionConfig["devices"]>[number],
  index: number,
): asserts device is NonNullable<RawExecutionConfig["devices"]>[number] & {
  id: string;
  target: string;
} {
  if (!device.id || device.id.trim().length === 0) {
    throw new Error(`config.devices[${index}].id is required.`);
  }
  if (!device.target || !isValidTarget(device.target)) {
    throw new Error(`config.devices[${index}].target is invalid.`);
  }
  if (hasOwn(device, "testFolders")) {
    throw new Error(
      `config.devices[${index}].testFolders has been renamed to testSuites.`,
    );
  }
}

function validateFoldControl(
  devices: ExecutionConfig["devices"],
  paths: ExecutionConfig["paths"],
): void {
  if (devices.some((device) => device.foldControl) && !paths.foldServerScript) {
    throw new Error(
      "config.paths.foldServerScript is required when any device has foldControl: true.",
    );
  }
}

function buildExecutionConfig(input: {
  project: string;
  raw: RawExecutionConfig;
  projectInfo: Awaited<ReturnType<typeof discoverProjectInfo>>;
  paths: ExecutionConfig["paths"];
  devices: ExecutionConfig["devices"];
  input: LoadExecutionConfigInput;
}): ExecutionConfig {
  const { project, raw, projectInfo, paths, devices } = input;
  const testClass = input.input.testClass ?? raw.testClass;
  return {
    project,
    product: raw.product ?? projectInfo.product,
    module: input.input.module ?? raw.module ?? projectInfo.moduleName,
    moduleSrcPath: projectInfo.moduleSrcPath,
    sharedModules: projectInfo.sharedModules,
    bundleName: raw.bundleName ?? projectInfo.bundleName,
    testModule: raw.testModule ?? projectInfo.testModuleName,
    testRunner: raw.testRunner ?? "OpenHarmonyTestRunner",
    ...(testClass ? { testClass } : {}),
    testCaseTimeoutMs: input.input.testCaseTimeoutMs ?? AA_TEST_CASE_TIMEOUT_MS,
    timeoutMs: raw.timeoutMs ?? 120000,
    build: readBuildConfig(raw),
    paths: readResolvedPaths(paths),
    artifacts: readArtifactConfig(project, raw, projectInfo),
    devices,
  };
}

function readBuildConfig(raw: RawExecutionConfig): ExecutionConfig["build"] {
  return {
    mode: raw.build?.mode ?? "project",
    appTask: raw.build?.appTask ?? "assembleApp",
    testTask: raw.build?.testTask ?? "ohosTest@PackageHap",
  };
}

function readResolvedPaths(
  paths: ExecutionConfig["paths"],
): ExecutionConfig["paths"] {
  return {
    hvigorw: paths.hvigorw,
    ohpm: paths.ohpm,
    hdc: paths.hdc,
    emulatorBin: paths.emulatorBin,
    emulatorDeployedDir: paths.emulatorDeployedDir,
    ...(paths.foldServerScript
      ? { foldServerScript: paths.foldServerScript }
      : {}),
  };
}

function readArtifactConfig(
  project: string,
  raw: RawExecutionConfig,
  projectInfo: Awaited<ReturnType<typeof discoverProjectInfo>>,
): ExecutionConfig["artifacts"] {
  return {
    appHap: resolveProjectPath(
      project,
      raw.artifacts?.appHap ?? projectInfo.appHap,
    ),
    testHap: resolveProjectPath(
      project,
      raw.artifacts?.testHap ?? projectInfo.testHap,
    ),
  };
}

function readToolPaths(
  rawPaths: RawExecutionConfig["paths"],
): ExecutionConfig["paths"] {
  return {
    hvigorw: readRequiredConfigString(
      rawPaths?.hvigorw,
      "config.paths.hvigorw",
    ),
    ohpm: rawPaths?.ohpm?.trim() || "ohpm",
    hdc: readRequiredConfigString(rawPaths?.hdc, "config.paths.hdc"),
    emulatorBin: readRequiredConfigString(
      rawPaths?.emulatorBin,
      "config.paths.emulatorBin",
    ),
    emulatorDeployedDir: readRequiredConfigString(
      rawPaths?.emulatorDeployedDir,
      "config.paths.emulatorDeployedDir",
    ),
    ...(rawPaths?.foldServerScript?.trim()
      ? { foldServerScript: rawPaths.foldServerScript.trim() }
      : {}),
  };
}

function readRequiredConfigString(
  value: string | undefined,
  configKey: string,
): string {
  const resolved = value?.trim() ?? "";
  if (resolved.length === 0) {
    throw new Error(`${configKey} is required.`);
  }
  return resolved;
}

function readDeviceTestSuites(value: unknown, deviceIndex: number): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `config.devices[${deviceIndex}].testSuites must be an array.`,
    );
  }
  const classes: string[] = [];
  const seen = new Set<string>();
  for (const suiteClass of value) {
    if (typeof suiteClass !== "string" || suiteClass.trim().length === 0) {
      throw new Error(
        `config.devices[${deviceIndex}].testSuites must contain non-empty suite class strings.`,
      );
    }
    const trimmedSuiteClass = suiteClass.trim();
    if (!seen.has(trimmedSuiteClass)) {
      classes.push(trimmedSuiteClass);
      seen.add(trimmedSuiteClass);
    }
  }
  return classes;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function defaultMachineConfigPath(): string {
  return path.resolve("config", "machine.json");
}

function resolveProjectPath(project: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(project, value);
}

function isValidTarget(value: string): boolean {
  return /^[A-Za-z0-9_.:-]+$/.test(value) && value.includes(":");
}

function readHdcPort(value: number, index: number): number {
  if (!Number.isInteger(value) || value < 10000 || value > 16555) {
    throw new Error(`config.devices[${index}].hdcPort is invalid.`);
  }
  return value;
}

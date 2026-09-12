import fs from "node:fs/promises";
import path from "node:path";
import {
  normalizeModuleSrcPath,
  selectHapModule,
  type ProjectModuleInfo,
} from "../execution/project/discovery.js";
import { parseJson5ish } from "../execution/project/json5ish.js";
import type {
  ExecutionResult,
  SuiteRunResult,
} from "../execution/types/index.js";

export const MODULE_DEVICE_TYPE_CHECK_SUITE =
  "ModuleDeviceTypeCompatibility";

export type HarmonyDeviceType =
  | "phone"
  | "tablet"
  | "tv"
  | "wearable"
  | "car"
  | "2in1";

export interface DeviceTypeRequirement {
  deviceId: string;
  deviceType: HarmonyDeviceType;
}

export interface DeviceTypeCompatibilityAssessment {
  modulePath: string;
  declaredDeviceTypes: string[];
  requiredByDevice: DeviceTypeRequirement[];
  injectedDeviceTypes: HarmonyDeviceType[];
}

export interface DeviceTypeCompatibilityRun<T> {
  value: T;
  assessment: DeviceTypeCompatibilityAssessment;
}

interface BuildProfile {
  app?: { products?: Array<{ name?: string }> };
  modules?: ProjectModuleInfo[];
}

interface MainModuleConfig {
  module?: { deviceTypes?: unknown };
}

interface CompatibilityFile {
  modulePath: string;
  original: string;
  config: MainModuleConfig;
  deviceTypes: string[];
}

export async function withCaseDeviceTypeCompatibility<T>(input: {
  project: string;
  module?: string;
  deviceIds: string[];
  run: () => Promise<T>;
}): Promise<DeviceTypeCompatibilityRun<T>> {
  const requiredByDevice = deviceTypeRequirements(input.deviceIds);
  const requiredTypes = dedupe(
    requiredByDevice.map(({ deviceType }) => deviceType),
  );
  const modulePaths = await resolveCompatibilityModulePaths(
    input.project,
    input.module,
  );
  const compatibilityFiles = await Promise.all(
    modulePaths.map(async (modulePath) => {
      const original = await readCompatibilityFile(modulePath);
      const config = readMainModuleConfig(original, modulePath);
      const deviceTypes = readDeviceTypes(config, modulePath);
      return { modulePath, original, config, deviceTypes };
    }),
  );
  const { assessment, filesToUpdate } = prepareCompatibility(
    compatibilityFiles,
    requiredByDevice,
    requiredTypes,
  );
  return runWithTemporaryCompatibility(
    filesToUpdate,
    requiredTypes,
    input.run,
    assessment,
  );
}

function prepareCompatibility(
  compatibilityFiles: CompatibilityFile[],
  requiredByDevice: DeviceTypeRequirement[],
  requiredTypes: HarmonyDeviceType[],
): {
  assessment: DeviceTypeCompatibilityAssessment;
  filesToUpdate: CompatibilityFile[];
} {
  const hapFile = compatibilityFiles[0]!;
  const injectedDeviceTypes = requiredTypes.filter(
    (deviceType) => !hapFile.deviceTypes.includes(deviceType),
  );
  const assessment: DeviceTypeCompatibilityAssessment = {
    modulePath: hapFile.modulePath,
    declaredDeviceTypes: [...hapFile.deviceTypes],
    requiredByDevice,
    injectedDeviceTypes,
  };
  const filesToUpdate = compatibilityFiles.filter(({ deviceTypes }) =>
    requiredTypes.some((deviceType) => !deviceTypes.includes(deviceType)),
  );
  return { assessment, filesToUpdate };
}

async function runWithTemporaryCompatibility<T>(
  filesToUpdate: CompatibilityFile[],
  requiredTypes: HarmonyDeviceType[],
  run: () => Promise<T>,
  assessment: DeviceTypeCompatibilityAssessment,
): Promise<DeviceTypeCompatibilityRun<T>> {
  const updatedFiles: CompatibilityFile[] = [];
  let runError: unknown;
  try {
    for (const file of filesToUpdate) {
      file.config.module!.deviceTypes = [
        ...file.deviceTypes,
        ...requiredTypes.filter(
          (deviceType) => !file.deviceTypes.includes(deviceType),
        ),
      ];
      updatedFiles.push(file);
      await writeTemporaryConfig(file.modulePath, file.config);
    }
    return { value: await run(), assessment };
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    await restoreOriginalConfigs(updatedFiles, runError);
  }
}

export function harmonyDeviceTypeFor(deviceId: string): HarmonyDeviceType {
  if (
    deviceId === "phone" ||
    deviceId === "wide_fold" ||
    deviceId === "foldable"
  ) {
    return "phone";
  }
  if (deviceId === "pc" || deviceId === "2in1") return "2in1";
  if (
    deviceId === "tablet" ||
    deviceId === "tv" ||
    deviceId === "wearable" ||
    deviceId === "car"
  ) {
    return deviceId;
  }
  throw new Error(`case_device_type_unmapped: ${deviceId}`);
}

export function applyAnswerDeviceTypeChecks(
  execution: ExecutionResult,
  assessment: DeviceTypeCompatibilityAssessment,
): ExecutionResult {
  const requirements = new Map(
    assessment.requiredByDevice.map(({ deviceId, deviceType }) => [
      deviceId,
      deviceType,
    ]),
  );
  return {
    ...execution,
    devices: execution.devices.map((device) => {
      const deviceType = requirements.get(device.id);
      if (!deviceType) return device;
      const declared = assessment.declaredDeviceTypes.includes(deviceType);
      const check = answerDeviceTypeCheck(
        assessment.modulePath,
        deviceType,
        declared,
      );
      return {
        ...device,
        status:
          !declared && device.status !== "blocked" ? "failed" : device.status,
        testsRun: device.testsRun + 1,
        failures: device.failures + (declared ? 0 : 1),
        passes: device.passes + (declared ? 1 : 0),
        suiteResults: [...device.suiteResults, check],
      };
    }),
  };
}

function deviceTypeRequirements(deviceIds: string[]): DeviceTypeRequirement[] {
  return dedupe(deviceIds).map((deviceId) => ({
    deviceId,
    deviceType: harmonyDeviceTypeFor(deviceId),
  }));
}

function answerDeviceTypeCheck(
  modulePath: string,
  deviceType: HarmonyDeviceType,
  declared: boolean,
): SuiteRunResult {
  return {
    suiteClass: MODULE_DEVICE_TYPE_CHECK_SUITE,
    status: declared ? "passed" : "failed",
    testsRun: 1,
    failures: declared ? 0 : 1,
    errors: 0,
    passes: declared ? 1 : 0,
    ignored: 0,
    reportCode: declared ? 0 : -1,
    ok: declared,
    testCases: [
      {
        name: `should_declare_${deviceType}_device_type`,
        status: declared ? "passed" : "failed",
        statusCode: declared ? 0 : -2,
        ...(!declared
          ? {
              message: `${modulePath} module.deviceTypes does not include "${deviceType}"; the runner temporarily injected it for test execution.`,
            }
          : {}),
      },
    ],
  };
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}

async function resolveCompatibilityModulePaths(
  project: string,
  module?: string,
): Promise<string[]> {
  const buildProfilePath = path.join(project, "build-profile.json5");
  let buildProfile: BuildProfile;
  try {
    buildProfile = parseJson5ish(
      await fs.readFile(buildProfilePath, "utf-8"),
    ) as BuildProfile;
  } catch (error) {
    throw new Error(
      `case_device_type_compatibility_entry_module_not_found: ${buildProfilePath}: ${formatError(error)}`,
    );
  }
  if (!Array.isArray(buildProfile.modules)) {
    throw new Error(
      `case_device_type_compatibility_entry_module_not_found: ${buildProfilePath}: modules must be an array.`,
    );
  }
  const product = buildProfile.app?.products?.[0]?.name ?? "default";
  const moduleInfo = await selectHapModule(
    project,
    product,
    buildProfile.modules,
    module,
  );
  const srcPath = moduleInfo.srcPath ?? moduleInfo.name;
  if (typeof srcPath !== "string" || srcPath.trim().length === 0) {
    throw new Error(
      `case_device_type_compatibility_entry_module_not_found: ${buildProfilePath}`,
    );
  }
  const entryModulePath = path.join(
    project,
    normalizeModuleSrcPath(srcPath),
    "src",
    "main",
    "module.json5",
  );
  const hspModulePaths = await resolveHspMainModulePaths(
    project,
    product,
    buildProfile.modules,
  );
  return [entryModulePath, ...hspModulePaths];
}

async function resolveHspMainModulePaths(
  project: string,
  product: string,
  modules: ProjectModuleInfo[],
): Promise<string[]> {
  const modulePaths: string[] = [];
  for (const moduleInfo of modules) {
    const srcPath = moduleInfo.srcPath?.trim();
    if (!srcPath || !appliesToProduct(moduleInfo, product)) continue;
    const normalizedSrcPath = normalizeModuleSrcPath(srcPath);
    const hvigorfile = await fs.readFile(
      path.join(project, normalizedSrcPath, "hvigorfile.ts"),
      "utf-8",
    );
    if (!/\bhspTasks\b/.test(hvigorfile)) continue;
    modulePaths.push(
      path.join(project, normalizedSrcPath, "src", "main", "module.json5"),
    );
  }
  return modulePaths;
}

function appliesToProduct(
  moduleInfo: ProjectModuleInfo,
  product: string,
): boolean {
  if (!moduleInfo.targets || moduleInfo.targets.length === 0) return true;
  return moduleInfo.targets.some((target) =>
    target.applyToProducts?.includes(product),
  );
}

async function readCompatibilityFile(modulePath: string): Promise<string> {
  try {
    return await fs.readFile(modulePath, "utf-8");
  } catch (error) {
    throw new Error(
      `case_device_type_compatibility_read_failed: ${modulePath}: ${formatError(error)}`,
    );
  }
}

function readMainModuleConfig(
  original: string,
  modulePath: string,
): MainModuleConfig {
  try {
    return parseJson5ish(original) as MainModuleConfig;
  } catch (error) {
    throw new Error(
      `case_device_type_compatibility_invalid_module: ${modulePath}: ${formatError(error)}`,
    );
  }
}

function readDeviceTypes(
  config: MainModuleConfig,
  modulePath: string,
): string[] {
  const deviceTypes = config.module?.deviceTypes;
  if (
    !Array.isArray(deviceTypes) ||
    deviceTypes.some((deviceType) => typeof deviceType !== "string")
  ) {
    throw new Error(
      `case_device_type_compatibility_invalid_module: ${modulePath}: module.deviceTypes must be a string array.`,
    );
  }
  return deviceTypes;
}

async function writeTemporaryConfig(
  modulePath: string,
  config: MainModuleConfig,
): Promise<void> {
  try {
    await fs.writeFile(
      modulePath,
      `${JSON.stringify(config, null, 2)}\n`,
      "utf-8",
    );
  } catch (error) {
    throw new Error(
      `case_device_type_compatibility_write_failed: ${modulePath}: ${formatError(error)}`,
    );
  }
}

async function restoreOriginalConfig(
  modulePath: string,
  original: string,
  runError: unknown,
): Promise<void> {
  try {
    await fs.writeFile(modulePath, original, "utf-8");
  } catch (error) {
    const runFailure =
      runError === undefined ? "" : `; run failed: ${formatError(runError)}`;
    throw new Error(
      `case_device_type_compatibility_restore_failed: ${modulePath}: ${formatError(error)}${runFailure}`,
    );
  }
}

async function restoreOriginalConfigs(
  files: Array<{ modulePath: string; original: string }>,
  runError: unknown,
): Promise<void> {
  await Promise.all(
    files.map((file) =>
      restoreOriginalConfig(file.modulePath, file.original, runError),
    ),
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

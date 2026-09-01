import fs from "node:fs/promises";
import path from "node:path";
import {
  normalizeModuleSrcPath,
  selectHapModule,
  type ProjectModuleInfo,
} from "../execution/project/discovery.js";
import { parseJson5ish } from "../execution/project/json5ish.js";

interface BuildProfile {
  app?: { products?: Array<{ name?: string }> };
  modules?: ProjectModuleInfo[];
}

interface MainModuleConfig {
  module?: { deviceTypes?: unknown };
}

export async function withSweTabletCompatibility<T>(input: {
  project: string;
  module?: string;
  enabled: boolean;
  run: () => Promise<T>;
}): Promise<T> {
  if (!input.enabled) {
    return input.run();
  }

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
  const filesToUpdate = compatibilityFiles.filter(
    ({ deviceTypes }) => !deviceTypes.includes("tablet"),
  );
  if (filesToUpdate.length === 0) {
    return input.run();
  }

  const updatedFiles: typeof filesToUpdate = [];
  let runError: unknown;
  try {
    for (const file of filesToUpdate) {
      file.config.module!.deviceTypes = [...file.deviceTypes, "tablet"];
      updatedFiles.push(file);
      await writeTemporaryConfig(file.modulePath, file.config);
    }
    return await input.run();
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    await restoreOriginalConfigs(updatedFiles, runError);
  }
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
      `swe_tablet_compatibility_entry_module_not_found: ${buildProfilePath}: ${formatError(error)}`,
    );
  }
  if (!Array.isArray(buildProfile.modules)) {
    throw new Error(
      `swe_tablet_compatibility_entry_module_not_found: ${buildProfilePath}: modules must be an array.`,
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
      `swe_tablet_compatibility_entry_module_not_found: ${buildProfilePath}`,
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
      `swe_tablet_compatibility_read_failed: ${modulePath}: ${formatError(error)}`,
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
      `swe_tablet_compatibility_invalid_module: ${modulePath}: ${formatError(error)}`,
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
      `swe_tablet_compatibility_invalid_module: ${modulePath}: module.deviceTypes must be a string array.`,
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
      `swe_tablet_compatibility_write_failed: ${modulePath}: ${formatError(error)}`,
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
      `swe_tablet_compatibility_restore_failed: ${modulePath}: ${formatError(error)}${runFailure}`,
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

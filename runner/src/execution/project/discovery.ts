import fs from "node:fs/promises";
import path from "node:path";
import {
  ConfigFileError,
  configFileError,
  readJson5ConfigFile,
} from "../../configFile.js";
import type { SharedModuleInfo } from "../types/index.js";

export interface ProjectInfo {
  product: string;
  moduleName: string;
  moduleSrcPath: string;
  bundleName: string;
  testModuleName: string;
  appHap: string;
  testHap: string;
  sharedModules: SharedModuleInfo[];
}

export interface ProjectModuleInfo {
  name?: string;
  srcPath?: string;
  targets?: Array<{
    name?: string;
    applyToProducts?: string[];
  }>;
}

interface BuildProfile {
  app?: { products?: Array<{ name?: string }> };
  modules?: ProjectModuleInfo[];
}

interface AppConfig {
  app?: { bundleName?: string };
}

interface TestModuleConfig {
  module?: { name?: string };
}

interface MainModuleConfig {
  module?: { type?: string };
}

interface ModulePackageConfig {
  name?: string;
  dependencies?: Record<string, unknown>;
}

export async function discoverProjectInfo(
  project: string,
  requestedModule?: string,
): Promise<ProjectInfo> {
  const buildProfilePath = path.join(project, "build-profile.json5");
  const appJsonPath = path.join(project, "AppScope", "app.json5");
  const buildProfile =
    await readJson5ConfigFile<BuildProfile>(buildProfilePath);
  const appJson = await readJson5ConfigFile<AppConfig>(appJsonPath);
  return buildProjectInfo(
    project,
    buildProfilePath,
    appJsonPath,
    buildProfile,
    appJson,
    requestedModule,
  );
}

async function buildProjectInfo(
  project: string,
  buildProfilePath: string,
  appJsonPath: string,
  buildProfile: BuildProfile,
  appJson: AppConfig,
  requestedModule?: string,
): Promise<ProjectInfo> {
  const product = buildProfile.app?.products?.[0]?.name ?? "default";
  const modules = buildProfile.modules ?? [];
  const moduleInfo = await selectConfiguredHapModule(
    project,
    product,
    modules,
    buildProfilePath,
    requestedModule,
  );
  const moduleName = moduleInfo.name ?? "entry";
  const moduleSrcPath = normalizeModuleSrcPath(
    moduleInfo.srcPath ?? moduleName,
  );
  const ohosTestModulePath = path.join(
    project,
    moduleSrcPath,
    "src",
    "ohosTest",
    "module.json5",
  );
  const ohosTestModule =
    await readJson5ConfigFile<TestModuleConfig>(ohosTestModulePath);
  const bundleName = readBundleName(appJson, appJsonPath);

  const sharedModules = await discoverConfiguredSharedModules(
    project,
    product,
    modules,
    buildProfilePath,
  );

  return {
    product,
    moduleName,
    moduleSrcPath,
    bundleName,
    testModuleName: ohosTestModule.module?.name ?? `${moduleName}_test`,
    sharedModules,
    ...buildArtifactPaths(moduleSrcPath, moduleName, product),
  };
}

function readBundleName(appJson: AppConfig, appJsonPath: string): string {
  const bundleName = appJson.app?.bundleName;
  if (bundleName) return bundleName;
  throw configFileError(appJsonPath, new Error("app.bundleName is required."));
}

async function selectConfiguredHapModule(
  project: string,
  product: string,
  modules: ProjectModuleInfo[],
  buildProfilePath: string,
  requestedModule?: string,
): Promise<ProjectModuleInfo> {
  try {
    return await selectHapModule(project, product, modules, requestedModule);
  } catch (error) {
    throw configFileError(buildProfilePath, error);
  }
}

async function discoverConfiguredSharedModules(
  project: string,
  product: string,
  modules: ProjectModuleInfo[],
  buildProfilePath: string,
): Promise<SharedModuleInfo[]> {
  try {
    return await discoverSharedModules(project, product, modules);
  } catch (error) {
    throw configFileError(buildProfilePath, error);
  }
}

async function discoverSharedModules(
  project: string,
  product: string,
  modules: ProjectModuleInfo[],
): Promise<SharedModuleInfo[]> {
  const sharedModules: SharedModuleInfo[] = [];
  for (const moduleInfo of modules) {
    const sharedModule = await discoverSharedModule(
      project,
      product,
      moduleInfo,
    );
    if (sharedModule) sharedModules.push(sharedModule);
  }
  return orderSharedModules(sharedModules);
}

async function discoverSharedModule(
  project: string,
  product: string,
  moduleInfo: ProjectModuleInfo,
): Promise<SharedModuleInfo | undefined> {
  const name = moduleInfo.name?.trim();
  const rawSrcPath = moduleInfo.srcPath?.trim();
  if (!name || !rawSrcPath || !appliesToProduct(moduleInfo, product)) {
    return undefined;
  }
  const srcPath = normalizeModuleSrcPath(rawSrcPath);
  const moduleConfig = await readMainModuleConfig(project, name, srcPath);
  if (moduleConfig.module?.type !== "shared") return undefined;
  const packageConfig = await readModulePackageConfig(
    name,
    path.join(project, srcPath, "oh-package.json5"),
  );
  return {
    name,
    srcPath,
    packageName: packageConfig.name ?? name,
    dependencies: Object.keys(packageConfig.dependencies ?? {}),
    outputDir: path.join(
      project,
      srcPath,
      "build",
      product,
      "outputs",
      product,
    ),
  };
}

async function readMainModuleConfig(
  project: string,
  moduleName: string,
  srcPath: string,
): Promise<MainModuleConfig> {
  const moduleConfigPath = path.join(
    project,
    srcPath,
    "src",
    "main",
    "module.json5",
  );
  try {
    return await readJson5ConfigFile<MainModuleConfig>(moduleConfigPath);
  } catch (error) {
    throw contextualConfigError(
      error,
      `module ${moduleName} module.json5 could not be read at ${moduleConfigPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function readModulePackageConfig(
  moduleName: string,
  packageConfigPath: string,
): Promise<ModulePackageConfig> {
  try {
    return await readJson5ConfigFile<ModulePackageConfig>(packageConfigPath);
  } catch (error) {
    throw contextualConfigError(
      error,
      `module ${moduleName} oh-package.json5 could not be read at ${packageConfigPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function contextualConfigError(error: unknown, message: string): Error {
  return error instanceof ConfigFileError
    ? new ConfigFileError(message, error.errorCode, error.file, {
        cause: error,
      })
    : new Error(message, { cause: error });
}

function orderSharedModules(modules: SharedModuleInfo[]): SharedModuleInfo[] {
  const byPackageName = new Map(
    modules.map((moduleInfo) => [moduleInfo.packageName, moduleInfo]),
  );
  const ordered: SharedModuleInfo[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (moduleInfo: SharedModuleInfo): void => {
    if (visited.has(moduleInfo.packageName)) return;
    if (visiting.has(moduleInfo.packageName)) {
      throw new Error(
        `shared module dependency cycle includes ${moduleInfo.packageName}`,
      );
    }
    visiting.add(moduleInfo.packageName);
    for (const dependency of moduleInfo.dependencies) {
      const sharedDependency = byPackageName.get(dependency);
      if (sharedDependency) visit(sharedDependency);
    }
    visiting.delete(moduleInfo.packageName);
    visited.add(moduleInfo.packageName);
    ordered.push(moduleInfo);
  };
  for (const moduleInfo of modules) visit(moduleInfo);
  return ordered;
}

function appliesToProduct(
  moduleInfo: ProjectModuleInfo,
  product: string,
): boolean {
  if (!moduleInfo.targets || moduleInfo.targets.length === 0) {
    return true;
  }
  return moduleInfo.targets.some((target) =>
    target.applyToProducts?.includes(product),
  );
}

function buildArtifactPaths(
  moduleSrcPath: string,
  moduleName: string,
  product: string,
): Pick<ProjectInfo, "appHap" | "testHap"> {
  const outputRoot = path.join(moduleSrcPath, "build", product, "outputs");
  return {
    appHap: path.join(
      outputRoot,
      product,
      `${moduleName}-${product}-unsigned.hap`,
    ),
    testHap: path.join(
      outputRoot,
      "ohosTest",
      `${moduleName}-ohosTest-unsigned.hap`,
    ),
  };
}

export async function selectHapModule(
  project: string,
  product: string,
  modules: ProjectModuleInfo[],
  requestedModule?: string,
): Promise<ProjectModuleInfo> {
  if (requestedModule) {
    const requested = modules.find(
      (moduleInfo) => moduleInfo.name?.trim() === requestedModule,
    );
    if (!requested || !appliesToProduct(requested, product)) {
      throw new Error(`project_hap_module_invalid: ${requestedModule}`);
    }
    const srcPath = requested.srcPath?.trim();
    if (!srcPath) {
      throw new Error(`project_hap_module_invalid: ${requestedModule}`);
    }
    const hvigorfile = await fs.readFile(
      path.join(project, normalizeModuleSrcPath(srcPath), "hvigorfile.ts"),
      "utf-8",
    );
    if (!/\bhapTasks\b/.test(hvigorfile)) {
      throw new Error(`project_hap_module_invalid: ${requestedModule}`);
    }
    return requested;
  }
  const matches: ProjectModuleInfo[] = [];
  for (const moduleInfo of modules) {
    if (!appliesToProduct(moduleInfo, product)) continue;
    const name = moduleInfo.name?.trim();
    const rawSrcPath = moduleInfo.srcPath?.trim();
    if (!name || !rawSrcPath) continue;
    const hvigorfile = await fs.readFile(
      path.join(project, normalizeModuleSrcPath(rawSrcPath), "hvigorfile.ts"),
      "utf-8",
    );
    if (/\bhapTasks\b/.test(hvigorfile)) {
      matches.push(moduleInfo);
    }
  }
  if (matches.length === 0) {
    throw new Error(`project_hap_module_not_found: ${project}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `project_hap_module_ambiguous: ${matches
        .map((moduleInfo) => moduleInfo.name)
        .join(", ")}`,
    );
  }
  return matches[0]!;
}

export function normalizeModuleSrcPath(value: string): string {
  return value.replace(/^\.\//, "");
}

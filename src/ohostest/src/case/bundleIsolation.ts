import fs from "node:fs/promises";
import path from "node:path";
import { readJson5ConfigFile } from "../configFile.js";
import type { ExecutionConfig } from "../execution/types/index.js";

const BUNDLE_NAME_MAX_BYTES = 127;

export interface PreparedExecutionGroupLike {
  module?: string;
  executionConfig: ExecutionConfig;
}

const BUNDLE_NAME_MAX_BYTES_LIMIT = 127;

export interface BundleNameCleanupConfig {
  prefixes: string[];
  keep: string[];
}

export async function readBundleName(project: string): Promise<string> {
  const appJsonPath = path.join(project, "AppScope", "app.json5");
  const appJson = await readJson5ConfigFile<{ app?: { bundleName?: string } }>(
    appJsonPath,
  );
  const bundleName = appJson.app?.bundleName;
  if (!bundleName) {
    throw new Error(`bundle_name_missing: ${appJsonPath}`);
  }
  return bundleName;
}

export async function rewriteBundleName(
  project: string,
  bundleName: string,
): Promise<void> {
  if (Buffer.byteLength(bundleName, "utf-8") > BUNDLE_NAME_MAX_BYTES_LIMIT) {
    throw new Error(
      `bundle_name_too_long: ${bundleName} exceeds ${BUNDLE_NAME_MAX_BYTES_LIMIT} bytes`,
    );
  }
  const appJsonPath = path.join(project, "AppScope", "app.json5");
  const content = await fs.readFile(appJsonPath, "utf-8");
  const pattern = /("bundleName"\s*:\s*")([^"]*)(")/;
  if (!pattern.test(content)) {
    throw new Error(`bundle_name_not_found: ${appJsonPath}`);
  }
  const rewritten = content.replace(pattern, `$1${bundleName}$3`);
  await fs.writeFile(appJsonPath, rewritten, "utf-8");
}

export function buildIsolatedBundleNames(
  originalBundleName: string,
): { swe: string; answer: () => string } {
  return {
    swe: `${originalBundleName}.swe`,
    answer: () => `${originalBundleName}.answer.${Date.now()}`,
  };
}

export function cleanupTargetsFor(
  originalBundleName: string,
  keep: string[],
): BundleNameCleanupConfig {
  return {
    prefixes: [`${originalBundleName}.`],
    keep: [...keep, originalBundleName],
  };
}

export function applyBundleNameCleanup(
  executionGroups: PreparedExecutionGroupLike[],
  cleanup: BundleNameCleanupConfig,
): void {
  for (const group of executionGroups) {
    group.executionConfig = {
      ...group.executionConfig,
      bundleNameCleanup: cleanup,
    } satisfies ExecutionConfig;
  }
}

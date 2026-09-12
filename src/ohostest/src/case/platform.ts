import type { CasePlatform } from "./types/index.js";

export function readPlatformSettings(raw: { platform?: unknown }): {
  platform?: CasePlatform;
} {
  if (
    raw.platform !== undefined &&
    raw.platform !== "native" &&
    raw.platform !== "web" &&
    raw.platform !== "rn" &&
    raw.platform !== "flutter"
  ) {
    throw new Error(`case_platform_unsupported: ${String(raw.platform)}`);
  }
  return raw.platform === undefined ? {} : { platform: raw.platform };
}

export interface RnBuildSettings {
  bundleCommands: string[];
}

export function readRnBuildSettings(raw: {
  rn_build?: unknown;
  platform?: unknown;
}): { rnBuild?: RnBuildSettings } {
  if (raw.rn_build === undefined) {
    return {};
  }
  if (
    !raw.rn_build ||
    typeof raw.rn_build !== "object" ||
    Array.isArray(raw.rn_build)
  ) {
    throw new Error("metadata.rn_build must be an object.");
  }
  if (raw.platform !== "rn") {
    throw new Error('metadata.rn_build is only valid when platform is "rn".');
  }
  const bundleCommands = readBundleCommands(
    (raw.rn_build as { bundle_commands?: unknown }).bundle_commands,
  );
  return { rnBuild: { bundleCommands } };
}

function readBundleCommands(value: unknown): string[] {
  if (value === undefined) {
    throw new Error(
      "metadata.rn_build.bundle_commands is required when rn_build is present.",
    );
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      "metadata.rn_build.bundle_commands must be a non-empty array.",
    );
  }
  return value.map((command, index) => {
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new Error(
        `metadata.rn_build.bundle_commands[${index}] must be a non-empty string.`,
      );
    }
    return command.trim();
  });
}

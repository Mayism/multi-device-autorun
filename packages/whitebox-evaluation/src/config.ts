import "dotenv/config";
import path from "node:path";

export interface WhiteboxRuntimeConfig {
  referenceRoot: string;
  officialCodeLinterEnabled: boolean;
  officialToolRunDir?: string;
  officialCodeLinterRunDir?: string;
  officialCodeLinterTimeoutMs: number;
  hvigorBuildCheckEnabled: boolean;
  hvigorBuildCheckRunDir?: string;
  hvigorBuildCheckTimeoutMs: number;
}

function isExplicitlyEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function getConfig(): WhiteboxRuntimeConfig {
  const officialCodeLinterEnabled = isExplicitlyEnabled(process.env.HMOS_CODE_LINTER_ENABLED);
  const hvigorBuildCheckEnabled =
    process.env.HMOS_HVIGOR_BUILD_CHECK_ENABLED === undefined
      ? officialCodeLinterEnabled
      : isExplicitlyEnabled(process.env.HMOS_HVIGOR_BUILD_CHECK_ENABLED);
  const officialToolRunDir = process.env.HMOS_OFFICIAL_TOOL_RUN_DIR
    ? path.resolve(process.env.HMOS_OFFICIAL_TOOL_RUN_DIR)
    : undefined;
  const officialCodeLinterRunDir = officialToolRunDir
    ? path.join(officialToolRunDir, "codelinter")
    : process.env.HMOS_CODE_LINTER_RUN_DIR
      ? path.resolve(process.env.HMOS_CODE_LINTER_RUN_DIR)
      : undefined;
  const hvigorBuildCheckRunDir = officialToolRunDir
    ? path.join(officialToolRunDir, "hvigor")
    : officialCodeLinterRunDir
      ? path.join(path.dirname(officialCodeLinterRunDir), "hvigor")
      : undefined;

  return {
    referenceRoot:
      process.env.DEFAULT_REFERENCE_ROOT ?? path.resolve(process.cwd(), "references/scoring"),
    officialCodeLinterEnabled,
    officialToolRunDir,
    officialCodeLinterRunDir,
    officialCodeLinterTimeoutMs: Number(process.env.HMOS_CODE_LINTER_TIMEOUT_MS ?? 120000),
    hvigorBuildCheckEnabled,
    hvigorBuildCheckRunDir,
    hvigorBuildCheckTimeoutMs: Number(process.env.HMOS_HVIGOR_BUILD_CHECK_TIMEOUT_MS ?? 300000),
  };
}

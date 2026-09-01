import "dotenv/config";
import os from "node:os";
import path from "node:path";

export interface AppConfig {
  port: number;
  localCaseRoot: string;
  referenceRoot: string;
  humanReviewEvidenceRoot: string;
  remoteTaskAcceptTimeoutMs: number;
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

export function getConfig(): AppConfig {
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
    port: Number(process.env.PORT ?? 3000),
    localCaseRoot: path.resolve(process.cwd(), process.env.LOCAL_CASE_ROOT ?? ".local-cases"),
    referenceRoot:
      process.env.DEFAULT_REFERENCE_ROOT ?? path.resolve(process.cwd(), "references/scoring"),
    humanReviewEvidenceRoot: process.env.HUMAN_REVIEW_EVIDENCE_ROOT
      ? path.resolve(process.env.HUMAN_REVIEW_EVIDENCE_ROOT)
      : path.resolve(os.homedir(), ".hmos-score-agent", "human-review-evidences"),
    remoteTaskAcceptTimeoutMs: Number(process.env.REMOTE_TASK_ACCEPT_TIMEOUT_MS ?? 300000),
    officialCodeLinterEnabled,
    officialToolRunDir,
    officialCodeLinterRunDir,
    officialCodeLinterTimeoutMs: Number(process.env.HMOS_CODE_LINTER_TIMEOUT_MS ?? 120000),
    hvigorBuildCheckEnabled,
    hvigorBuildCheckRunDir,
    hvigorBuildCheckTimeoutMs: Number(process.env.HMOS_HVIGOR_BUILD_CHECK_TIMEOUT_MS ?? 300000),
  };
}

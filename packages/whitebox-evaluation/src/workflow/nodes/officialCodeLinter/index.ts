import { resolveOfficialCodeLinterRecommendedRuleSets } from "../../../rules/official-linter/config/recommendedRuleSets.js";
import { mapOfficialCodeLinterFindings } from "../../../rules/official-linter/map/resultMapper.js";
import { parseOfficialCodeLinterOutput } from "../../../rules/official-linter/parse/parser.js";
import { sanitizeOfficialCodeLinterOutput } from "../../../rules/official-linter/parse/sanitizer.js";
import {
  runOfficialCodeLinter,
  type OfficialCodeLinterRunResult,
} from "../../../rules/official-linter/run/runner.js";
import { prepareOfficialCodeLinterWorkspace } from "../../../rules/official-linter/run/workspacePreparer.js";
import type {
  HvigorBuildCheckStatus,
  OfficialLinterFinding,
  RuleAuditResult,
  OfficialLinterRunStatus,
  OfficialLinterSummary,
} from "../../../types.js";
import {
  emitNodeFailed,
  emitNodeStarted,
} from "../../observability/nodeCustomEvents.js";
import type { ScoreGraphState } from "../../graph/state.js";
import {
  appendDiagnostics,
  hasOfficialCodeLinterEntrypoint,
  makeSummary,
  readOfficialCodeLinterState,
  resolveBuildCheckSummary,
  resolveOfficialCodeLinterRuntime,
  summarizeMissingOfficialRuleProfiles,
  writeHvigorSummaryArtifact,
  writeSummaryArtifacts,
} from "./tools.js";
import type { OfficialCodeLinterNodeDeps } from "./types.js";

type LinterNodeContext = ReturnType<typeof createLinterNodeContext>;

function createLinterNodeContext(
  state: ScoreGraphState,
  deps: OfficialCodeLinterNodeDeps,
  startedAt: number,
) {
  const runtime = resolveOfficialCodeLinterRuntime(deps);
  const linterState = readOfficialCodeLinterState(state);
  return {
    state,
    runtime,
    linterState,
    startedAt,
    configuredRuleSets: resolveOfficialCodeLinterRecommendedRuleSets({
      crossDeviceAdaptation: linterState.crossDeviceAdaptation,
    }),
  };
}

function buildLinterResult(input: {
  runStatus: OfficialLinterRunStatus;
  summary: OfficialLinterSummary;
  findings?: OfficialLinterFinding[];
  ruleResults?: RuleAuditResult[];
  hvigorStatus: HvigorBuildCheckStatus;
  hvigorSummary: ScoreGraphState["hvigorBuildCheckSummary"];
}): Partial<ScoreGraphState> {
  return {
    officialLinterRunStatus: input.runStatus,
    officialLinterSummary: input.summary,
    officialLinterFindings: input.findings ?? [],
    officialLinterRuleResults: input.ruleResults ?? [],
    hvigorBuildCheckStatus: input.hvigorStatus,
    hvigorBuildCheckSummary: input.hvigorSummary,
  };
}

async function buildDisabledResult(
  context: LinterNodeContext,
): Promise<Partial<ScoreGraphState>> {
  const { runtime, linterState, startedAt, configuredRuleSets, state } =
    context;
  const hvigorSummary = await resolveBuildCheckSummary({
    hvigorEnabled: runtime.hvigorEnabled,
    hvigorRunDir: runtime.hvigorRunDir,
    changedFiles: linterState.changedFiles,
    timeoutMs: runtime.hvigorTimeoutMs,
    remoteBuildSuccess: state.remoteBuildSuccess,
    agentBuildResult: state.agentBuildResult,
  });
  const summary = makeSummary({
    runStatus: "not_enabled",
    effectiveFindingCount: 0,
    durationMs: Date.now() - startedAt,
    configuredRuleSets,
    diagnostics: appendDiagnostics(
      "official Code Linter is disabled by HMOS_CODE_LINTER_ENABLED",
      linterState.crossDeviceMissingDiagnostic,
    ),
  });
  return buildLinterResult({
    runStatus: "not_enabled",
    summary,
    hvigorStatus: hvigorSummary.status,
    hvigorSummary,
  });
}

async function buildUnavailableResult(
  context: LinterNodeContext,
): Promise<Partial<ScoreGraphState>> {
  const { runtime, linterState, startedAt, configuredRuleSets, state } =
    context;
  const runStatus: OfficialLinterRunStatus = runtime.enabled
    ? "not_installed"
    : "not_enabled";
  const diagnostics = runtime.enabled
    ? "official Code Linter run directory or entrypoint is unavailable"
    : "official Code Linter is disabled by HMOS_CODE_LINTER_ENABLED";
  const summary = makeSummary({
    runStatus,
    effectiveFindingCount: 0,
    durationMs: Date.now() - startedAt,
    configuredRuleSets,
    diagnostics: appendDiagnostics(
      diagnostics,
      linterState.crossDeviceMissingDiagnostic,
    ),
  });
  const hvigorSummary = await resolveBuildCheckSummary({
    hvigorEnabled: runtime.hvigorEnabled,
    hvigorRunDir: runtime.hvigorRunDir,
    changedFiles: linterState.changedFiles,
    timeoutMs: runtime.hvigorTimeoutMs,
    remoteBuildSuccess: state.remoteBuildSuccess,
    agentBuildResult: state.agentBuildResult,
  });
  await writeUnavailableArtifacts(
    linterState.caseDir,
    summary,
    runStatus,
    hvigorSummary,
  );
  return buildLinterResult({
    runStatus,
    summary,
    hvigorStatus: hvigorSummary.status,
    hvigorSummary,
  });
}

async function writeUnavailableArtifacts(
  caseDir: string | undefined,
  summary: OfficialLinterSummary,
  runStatus: OfficialLinterRunStatus,
  hvigorSummary: NonNullable<ScoreGraphState["hvigorBuildCheckSummary"]>,
): Promise<void> {
  if (!caseDir) {
    return;
  }
  const sanitized = sanitizeOfficialCodeLinterOutput({
    text: summary.diagnostics ?? "",
    effectiveFindingCount: 0,
    runStatus,
  });
  await writeSummaryArtifacts({
    caseDir,
    summary,
    findings: [],
    stdout: sanitized,
    stderr: sanitized,
  });
  await writeHvigorSummaryArtifact(caseDir, hvigorSummary);
}

function resolveRunStatus(input: {
  linterInstalled: boolean;
  enabled: boolean;
  runResult?: { status: string };
  parsedStatus: string;
}): OfficialLinterRunStatus {
  if (!input.linterInstalled) {
    return input.enabled ? "not_installed" : "not_enabled";
  }
  if (input.runResult?.status === "timeout") {
    return "timeout";
  }
  if (input.parsedStatus === "parsed") {
    return "success";
  }
  return input.runResult?.status === "failed" ? "failed" : "invalid_output";
}

async function prepareWorkspaceAndBuildCheck(context: LinterNodeContext) {
  const { runtime, linterState, configuredRuleSets, state } = context;
  const workspace = await prepareOfficialCodeLinterWorkspace({
    generatedProjectPath: linterState.generatedProjectPath as string,
    caseDir: linterState.caseDir as string,
    ruleSets: configuredRuleSets,
  });
  const hvigorSummary = await resolveBuildCheckSummary({
    hvigorEnabled: runtime.hvigorEnabled,
    hvigorRunDir: runtime.hvigorRunDir,
    workspaceDir: workspace.workspaceDir,
    changedFiles: linterState.changedFiles,
    changedLineNumbersByFile: linterState.changedLineNumbersByFile,
    timeoutMs: runtime.hvigorTimeoutMs,
    remoteBuildSuccess: state.remoteBuildSuccess,
    agentBuildResult: state.agentBuildResult,
  });
  return { workspaceDir: workspace.workspaceDir, hvigorSummary };
}

async function runCodeLinterIfAvailable(
  context: LinterNodeContext,
  workspaceDir: string,
): Promise<{
  linterInstalled: boolean;
  runResult?: OfficialCodeLinterRunResult;
}> {
  const { runtime } = context;
  const linterInstalled = runtime.enabled
    ? Boolean(
        runtime.runDir &&
        (await hasOfficialCodeLinterEntrypoint(runtime.runDir)),
      )
    : false;
  const runResult = linterInstalled
    ? await runOfficialCodeLinter({
        runDir: runtime.runDir as string,
        workspaceDir,
        timeoutMs: runtime.timeoutMs,
      })
    : undefined;
  return { linterInstalled, runResult };
}

function mapLinterOutput(input: {
  context: LinterNodeContext;
  workspaceDir: string;
  runResult?: OfficialCodeLinterRunResult;
  linterInstalled: boolean;
}) {
  const { linterState, runtime } = input.context;
  const parsed = input.runResult
    ? parseOfficialCodeLinterOutput({
        stdout: input.runResult.stdout,
        stderr: input.runResult.stderr,
      })
    : { status: "unparsed" as const, findings: [] };
  const mapped = mapOfficialCodeLinterFindings({
    findings: parsed.findings,
    workspaceDir: input.workspaceDir,
    hasPatch: linterState.hasPatch,
    changedFiles: linterState.changedFiles,
    changedLineNumbersByFile: linterState.changedLineNumbersByFile,
  });
  const runStatus = resolveRunStatus({
    linterInstalled: input.linterInstalled,
    enabled: runtime.enabled,
    runResult: input.runResult,
    parsedStatus: parsed.status,
  });
  return { runStatus, mapped };
}

async function runInstalledLinter(
  context: LinterNodeContext,
): Promise<Partial<ScoreGraphState>> {
  const caseDir = context.linterState.caseDir as string;
  const { workspaceDir, hvigorSummary } =
    await prepareWorkspaceAndBuildCheck(context);
  const { linterInstalled, runResult } = await runCodeLinterIfAvailable(
    context,
    workspaceDir,
  );
  const { runStatus, mapped } = mapLinterOutput({
    context,
    workspaceDir,
    runResult,
    linterInstalled,
  });
  const effectiveFindings =
    runStatus === "success" ? mapped.effectiveFindings : [];
  const ruleResults = runStatus === "success" ? mapped.ruleResults : [];
  const summary = buildRunSummary(
    context,
    runStatus,
    effectiveFindings.length,
    ruleResults,
    runResult,
  );
  await writeRunArtifacts(
    caseDir,
    summary,
    effectiveFindings,
    runResult,
    runStatus,
  );
  await writeHvigorSummaryArtifact(caseDir, hvigorSummary);
  return buildLinterResult({
    runStatus,
    summary,
    findings: effectiveFindings,
    ruleResults,
    hvigorStatus: hvigorSummary.status as HvigorBuildCheckStatus,
    hvigorSummary,
  });
}

function buildRunSummary(
  context: LinterNodeContext,
  runStatus: OfficialLinterRunStatus,
  effectiveFindingCount: number,
  ruleResults: Array<{ rule_id: string }>,
  runResult: { durationMs: number; exitCode?: number } | undefined,
): OfficialLinterSummary {
  const missingProfileDiagnostics =
    summarizeMissingOfficialRuleProfiles(ruleResults);
  return makeSummary({
    runStatus,
    effectiveFindingCount,
    durationMs: runResult?.durationMs ?? Date.now() - context.startedAt,
    configuredRuleSets: context.configuredRuleSets,
    exitCode: runResult?.exitCode,
    diagnostics: appendDiagnostics(
      runStatus === "success"
        ? undefined
        : runStatus === "not_enabled"
          ? "official Code Linter is disabled by HMOS_CODE_LINTER_ENABLED"
          : `official Code Linter status=${runStatus}`,
      missingProfileDiagnostics,
      context.linterState.crossDeviceMissingDiagnostic,
    ),
  });
}

async function writeRunArtifacts(
  caseDir: string,
  summary: OfficialLinterSummary,
  findings: OfficialLinterFinding[],
  runResult: OfficialCodeLinterRunResult | undefined,
  runStatus: OfficialLinterRunStatus,
): Promise<void> {
  const sanitizedStdout = sanitizeOfficialCodeLinterOutput({
    text: runResult?.stdout ?? summary.diagnostics ?? "",
    effectiveFindingCount: findings.length,
    runStatus,
  });
  const sanitizedStderr = sanitizeOfficialCodeLinterOutput({
    text: runResult?.stderr ?? "",
    effectiveFindingCount: findings.length,
    runStatus,
  });
  await writeSummaryArtifacts({
    caseDir,
    summary,
    findings,
    stdout: sanitizedStdout,
    stderr: sanitizedStderr,
    exitCode: runResult?.exitCode,
  });
}

/** official Code Linter 与 hvigor 编译检查节点，负责生成规则命中和构建硬门禁结果。 */
export async function officialCodeLinterNode(
  state: ScoreGraphState,
  deps: OfficialCodeLinterNodeDeps = {},
): Promise<Partial<ScoreGraphState>> {
  emitNodeStarted("officialCodeLinterNode");
  try {
    const context = createLinterNodeContext(state, deps, Date.now());
    if (!context.runtime.enabled && !context.runtime.hvigorEnabled) {
      return await buildDisabledResult(context);
    }
    if (
      !context.linterState.caseDir ||
      !context.linterState.generatedProjectPath
    ) {
      return await buildUnavailableResult(context);
    }
    return await runInstalledLinter(context);
  } catch (error) {
    emitNodeFailed("officialCodeLinterNode", error);
    throw error;
  }
}

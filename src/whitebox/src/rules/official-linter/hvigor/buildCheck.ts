import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type {
  HvigorDeprecatedApiWarning,
  HvigorBuildCheckModuleResult,
  HvigorBuildCheckStatus,
  HvigorBuildCheckSummary,
} from "../../../types.js";
import { stderrExcerptBytes, stdoutExcerptBytes } from "./constants.js";
import type { CommandResult, HvigorBuildCheckInput, HvigorModuleBuildTarget } from "./types.js";

export type { HvigorBuildCheckInput, HvigorModuleBuildTarget };

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/").replace(/\\/g, "/");
}

function stripAnsi(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
}

function excerptOutput(value: string, maxBytes: number): string | undefined {
  if (!value) {
    return undefined;
  }
  const buffer = Buffer.from(value, "utf-8");
  if (buffer.length <= maxBytes) {
    return value;
  }
  return buffer.subarray(buffer.length - maxBytes).toString("utf-8");
}

function makeEmptySummary(input: {
  enabled: boolean;
  status: HvigorBuildCheckStatus;
  hvigorRunDir?: string;
  diagnostics?: string;
  durationMs: number;
  hardGateTriggered?: boolean;
  scoreCap?: number;
  checkedModules?: string[];
  moduleResults?: HvigorBuildCheckModuleResult[];
}): HvigorBuildCheckSummary {
  return {
    enabled: input.enabled,
    status: input.status,
    hvigorRunDir: input.hvigorRunDir,
    checkedModules: input.checkedModules ?? [],
    moduleResults: input.moduleResults ?? [],
    hardGateTriggered: input.hardGateTriggered ?? false,
    scoreCap: input.scoreCap,
    diagnostics: input.diagnostics,
    durationMs: input.durationMs,
    cleanup: {
      attempted: false,
      removedPaths: [],
      failedPaths: [],
    },
  };
}

export function detectChangedHarmonyModules(changedFiles: string[]): string[] {
  const modules = new Set<string>();
  for (const changedFile of changedFiles) {
    const segments = toPosixPath(changedFile).split("/").filter(Boolean);
    const srcIndex = segments.findIndex(
      (segment, index) => segment === "src" && segments[index + 1] === "main",
    );
    if (srcIndex < 0) {
      continue;
    }
    modules.add(srcIndex === 0 ? "." : segments.slice(0, srcIndex).join("/"));
  }
  return Array.from(modules).sort((left, right) => left.localeCompare(right));
}

async function readFirstExistingFile(paths: string[]): Promise<string | undefined> {
  for (const filePath of paths) {
    try {
      return await fs.readFile(filePath, "utf-8");
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function detectHvigorModuleBuildTarget(
  workspaceDir: string,
  modulePath: string,
): Promise<HvigorModuleBuildTarget> {
  const moduleRoot = modulePath === "." ? workspaceDir : path.join(workspaceDir, modulePath);
  const content = await readFirstExistingFile([
    path.join(moduleRoot, "hvigorfile.ts"),
    path.join(moduleRoot, "hvigorfile.js"),
  ]);
  if (!content) {
    return "unknown";
  }
  if (/\bhapTasks\b/.test(content)) {
    return "hap";
  }
  if (/\bharTasks\b/.test(content)) {
    return "har";
  }
  if (/\bhspTasks\b/.test(content)) {
    return "hsp";
  }
  return "unknown";
}

function commandForTarget(
  target: HvigorModuleBuildTarget,
): HvigorBuildCheckModuleResult["command"] | undefined {
  if (target === "hap") {
    return "assembleHap";
  }
  if (target === "har") {
    return "assembleHar";
  }
  if (target === "hsp") {
    return "assembleHsp";
  }
  return undefined;
}

function moduleNameFromPath(modulePath: string): string {
  if (modulePath === ".") {
    return "entry";
  }
  const segments = modulePath.split("/").filter(Boolean);
  return segments.at(-1) ?? modulePath;
}

async function findHvigorw(hvigorRunDir: string): Promise<string | undefined> {
  const candidates = [
    path.join(hvigorRunDir, "hvigorw"),
    path.join(hvigorRunDir, "bin", "hvigorw"),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function findOhpm(hvigorRunDir: string): Promise<string | undefined> {
  const toolRoot = path.dirname(hvigorRunDir);
  const candidates = [
    path.join(toolRoot, "ohpm", "bin", "ohpm"),
    path.join(toolRoot, "bin", "ohpm"),
    path.join(toolRoot, "ohpm"),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function runCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}): Promise<CommandResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    const finish = (result: Omit<CommandResult, "durationMs">) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        stdout: excerptOutput(result.stdout, stdoutExcerptBytes) ?? "",
        stderr: excerptOutput(result.stderr, stderrExcerptBytes) ?? "",
        durationMs: Date.now() - startedAt,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      finish({
        status: "failed",
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: `${Buffer.concat(stderrChunks).toString("utf-8")}\n${error.message}`.trim(),
      });
    });
    child.on("close", (code) => {
      finish({
        status: timedOut ? "timeout" : code === 0 ? "success" : "failed",
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: code ?? undefined,
      });
    });
  });
}

function isInsideWorkspace(workspaceDir: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(workspaceDir), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeHvigorWarningFile(workspaceDir: string, warningFile: string): string | undefined {
  const normalizedWorkspaceDir = toPosixPath(path.resolve(workspaceDir));
  const normalizedWarningFile = toPosixPath(path.resolve(warningFile));
  if (normalizedWarningFile === normalizedWorkspaceDir) {
    return ".";
  }
  if (!normalizedWarningFile.startsWith(`${normalizedWorkspaceDir}/`)) {
    return undefined;
  }
  return normalizedWarningFile.slice(normalizedWorkspaceDir.length + 1);
}

function collectDeprecatedApiWarnings(input: {
  workspaceDir: string;
  moduleResults: HvigorBuildCheckModuleResult[];
  changedLineNumbersByFile?: Record<string, number[]>;
}): HvigorDeprecatedApiWarning[] | undefined {
  const changedLineNumbersByFile = input.changedLineNumbersByFile ?? {};
  const warnings: HvigorDeprecatedApiWarning[] = [];
  const seen = new Set<string>();
  const pattern =
    /ArkTS:WARN\s+File:\s*(?<file>.+?):(?<line>\d+):(?<column>\d+)\s*\r?\n\s*'(?<apiName>[^']+)'\s+has been deprecated\./g;

  for (const result of input.moduleResults) {
    const output = stripAnsi(`${result.stdoutExcerpt ?? ""}\n${result.stderrExcerpt ?? ""}`);
    for (const match of output.matchAll(pattern)) {
      const groups = match.groups;
      if (!groups) {
        continue;
      }
      const relativeFile = normalizeHvigorWarningFile(input.workspaceDir, groups.file);
      if (!relativeFile) {
        continue;
      }
      const line = Number(groups.line);
      const changedLines = changedLineNumbersByFile[relativeFile] ?? [];
      if (!changedLines.includes(line)) {
        continue;
      }
      const apiName = groups.apiName;
      const dedupeKey = `${relativeFile}:${line}:${groups.column}:${apiName}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      warnings.push({
        file: relativeFile,
        line,
        column: Number(groups.column),
        apiName,
        modulePath: result.modulePath,
        moduleName: result.moduleName,
        command: result.command,
        message: `ArkTS:WARN File: ${relativeFile}:${line}:${groups.column} '${apiName}' has been deprecated.`,
      });
    }
  }

  return warnings.length > 0 ? warnings : undefined;
}

async function cleanupBuildArtifacts(
  workspaceDir: string,
  modulePaths: string[],
): Promise<HvigorBuildCheckSummary["cleanup"]> {
  const candidates = [
    path.join(workspaceDir, ".hvigor"),
    path.join(workspaceDir, "build"),
    path.join(workspaceDir, "oh_modules"),
    ...modulePaths.flatMap((modulePath) => {
      const moduleRoot = modulePath === "." ? workspaceDir : path.join(workspaceDir, modulePath);
      return [
        path.join(moduleRoot, "build"),
        path.join(moduleRoot, "oh_modules"),
        path.join(moduleRoot, ".preview"),
      ];
    }),
  ];
  const removedPaths: string[] = [];
  const failedPaths: Array<{ path: string; reason: string }> = [];
  for (const candidate of Array.from(new Set(candidates))) {
    const relativePath = toPosixPath(path.relative(workspaceDir, candidate)) || ".";
    if (!isInsideWorkspace(workspaceDir, candidate)) {
      failedPaths.push({ path: relativePath, reason: "cleanup target escapes workspace" });
      continue;
    }
    try {
      await fs.rm(candidate, { recursive: true, force: true });
      removedPaths.push(relativePath);
    } catch (error) {
      failedPaths.push({
        path: relativePath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    attempted: true,
    removedPaths,
    failedPaths,
  };
}

async function applyCleanupPolicy(
  summary: HvigorBuildCheckSummary,
  workspaceDir: string,
  modulePaths: string[],
): Promise<HvigorBuildCheckSummary> {
  if (summary.status === "failed" || summary.status === "timeout") {
    return summary;
  }
  summary.cleanup = await cleanupBuildArtifacts(workspaceDir, modulePaths);
  return summary;
}

function commandArgsForModule(input: {
  command: HvigorBuildCheckModuleResult["command"];
  moduleName: string;
}): string[] {
  return [
    input.command,
    "--mode",
    "module",
    "-p",
    `module=${input.moduleName}@default`,
    "-p",
    "product=default",
    "--no-daemon",
  ];
}

function commandArgsForApp(): string[] {
  return ["assembleApp", "--no-daemon"];
}

function appBuildFailureDiagnostics(status: "failed" | "timeout"): string {
  const reason = status === "timeout" ? "超时" : "失败";
  return `整包 assembleApp 编译${reason}：组件包可编译，但整包编译未通过，判断为原代码问题，非新增修改引入。`;
}

function buildFinalSummary(input: {
  enabled: boolean;
  status: HvigorBuildCheckStatus;
  hvigorRunDir?: string;
  checkedModules: string[];
  moduleResults: HvigorBuildCheckModuleResult[];
  startedAt: number;
  diagnostics?: string;
}): HvigorBuildCheckSummary {
  const hardGateTriggered = input.status === "failed" || input.status === "timeout";
  return {
    enabled: input.enabled,
    status: input.status,
    hvigorRunDir: input.hvigorRunDir,
    checkedModules: input.checkedModules,
    moduleResults: input.moduleResults,
    hardGateTriggered,
    scoreCap: hardGateTriggered ? 59 : undefined,
    diagnostics:
      input.diagnostics ??
      (input.status === "success"
        ? undefined
        : input.status === "skipped"
          ? "changed modules do not declare supported hvigor task types"
          : `hvigor build check ${input.status}`),
    durationMs: Date.now() - input.startedAt,
    cleanup: {
      attempted: false,
      removedPaths: [],
      failedPaths: [],
    },
  };
}

export async function runHvigorBuildCheck(
  input: HvigorBuildCheckInput,
): Promise<HvigorBuildCheckSummary> {
  const startedAt = Date.now();
  if (!input.enabled) {
    return makeEmptySummary({
      enabled: false,
      status: "not_enabled",
      durationMs: Date.now() - startedAt,
      diagnostics: "hvigor build check is disabled by HMOS_HVIGOR_BUILD_CHECK_ENABLED",
    });
  }
  if (!input.workspaceDir) {
    return makeEmptySummary({
      enabled: true,
      status: "tool_unavailable",
      hvigorRunDir: input.hvigorRunDir,
      durationMs: Date.now() - startedAt,
      diagnostics: "hvigor build check workspace is unavailable",
      hardGateTriggered: true,
      scoreCap: 59,
    });
  }

  const modules = detectChangedHarmonyModules(input.changedFiles);
  if (modules.length === 0) {
    const summary = makeEmptySummary({
      enabled: true,
      status: "skipped",
      hvigorRunDir: input.hvigorRunDir,
      checkedModules: [],
      durationMs: Date.now() - startedAt,
      diagnostics: "no changed HarmonyOS module under src/main",
    });
    return applyCleanupPolicy(summary, input.workspaceDir, []);
  }

  if (!input.hvigorRunDir) {
    const summary = makeEmptySummary({
      enabled: true,
      status: "tool_unavailable",
      checkedModules: modules,
      durationMs: Date.now() - startedAt,
      diagnostics: "hvigor run directory is unavailable",
      hardGateTriggered: true,
      scoreCap: 59,
    });
    return applyCleanupPolicy(summary, input.workspaceDir, modules);
  }

  const hvigorw = await findHvigorw(input.hvigorRunDir);
  if (!hvigorw) {
    const summary = makeEmptySummary({
      enabled: true,
      status: "tool_unavailable",
      hvigorRunDir: input.hvigorRunDir,
      checkedModules: modules,
      durationMs: Date.now() - startedAt,
      diagnostics: "hvigorw is unavailable",
      hardGateTriggered: true,
      scoreCap: 59,
    });
    return applyCleanupPolicy(summary, input.workspaceDir, modules);
  }

  const versionResult = await runCommand({
    command: hvigorw,
    args: ["--version"],
    cwd: input.workspaceDir,
    timeoutMs: input.timeoutMs,
  });
  if (versionResult.status !== "success") {
    const status = versionResult.status === "timeout" ? "timeout" : "tool_unavailable";
    const summary = makeEmptySummary({
      enabled: true,
      status,
      hvigorRunDir: input.hvigorRunDir,
      checkedModules: modules,
      durationMs: Date.now() - startedAt,
      diagnostics: `hvigorw --version ${versionResult.status}`,
      hardGateTriggered: true,
      scoreCap: 59,
    });
    return applyCleanupPolicy(summary, input.workspaceDir, modules);
  }

  const moduleResults: HvigorBuildCheckModuleResult[] = [];
  const compilableModules: Array<{
    modulePath: string;
    moduleName: string;
    command: HvigorBuildCheckModuleResult["command"];
  }> = [];
  for (const modulePath of modules) {
    const target = await detectHvigorModuleBuildTarget(input.workspaceDir, modulePath);
    const command = commandForTarget(target);
    const moduleName = moduleNameFromPath(modulePath);
    if (!command) {
      moduleResults.push({
        modulePath,
        moduleName,
        command: "assembleHar",
        status: "skipped",
        durationMs: 0,
        diagnostics: "module hvigorfile does not declare hapTasks, harTasks, or hspTasks",
      });
      continue;
    }
    compilableModules.push({ modulePath, moduleName, command });
  }

  if (compilableModules.length === 0) {
    const summary = buildFinalSummary({
      enabled: true,
      status: "skipped",
      hvigorRunDir: input.hvigorRunDir,
      checkedModules: modules,
      moduleResults,
      startedAt,
    });
    summary.durationMs = Date.now() - startedAt;
    return applyCleanupPolicy(summary, input.workspaceDir, modules);
  }

  const ohpm = await findOhpm(input.hvigorRunDir);
  if (!ohpm) {
    const summary = makeEmptySummary({
      enabled: true,
      status: "tool_unavailable",
      hvigorRunDir: input.hvigorRunDir,
      checkedModules: modules,
      durationMs: Date.now() - startedAt,
      diagnostics: "ohpm is unavailable",
      hardGateTriggered: true,
      scoreCap: 59,
    });
    return applyCleanupPolicy(summary, input.workspaceDir, modules);
  }

  const installResult = await runCommand({
    command: ohpm,
    args: ["install"],
    cwd: input.workspaceDir,
    timeoutMs: input.timeoutMs,
  });
  if (installResult.status !== "success") {
    const status: HvigorBuildCheckStatus =
      installResult.status === "timeout" ? "timeout" : "failed";
    const summary = makeEmptySummary({
      enabled: true,
      status,
      hvigorRunDir: input.hvigorRunDir,
      checkedModules: modules,
      durationMs: Date.now() - startedAt,
      diagnostics: `ohpm install ${installResult.status}`,
      hardGateTriggered: true,
      scoreCap: 59,
    });
    summary.moduleResults = [];
    return applyCleanupPolicy(summary, input.workspaceDir, modules);
  }

  for (const { command, moduleName, modulePath } of compilableModules) {
    const commandResult = await runCommand({
      command: hvigorw,
      args: commandArgsForModule({ command, moduleName }),
      cwd: input.workspaceDir,
      timeoutMs: input.timeoutMs,
    });
    moduleResults.push({
      modulePath,
      moduleName,
      command,
      status: commandResult.status,
      exitCode: commandResult.exitCode,
      durationMs: commandResult.durationMs,
      stdoutExcerpt: commandResult.stdout,
      stderrExcerpt: commandResult.stderr,
    });
  }

  const componentFailed = moduleResults.find((result) => result.status === "failed");
  const componentTimedOut = moduleResults.find((result) => result.status === "timeout");
  const componentCompiled = moduleResults.filter((result) => result.status !== "skipped");
  if (!componentFailed && !componentTimedOut && componentCompiled.length > 0) {
    const appCommandResult = await runCommand({
      command: hvigorw,
      args: commandArgsForApp(),
      cwd: input.workspaceDir,
      timeoutMs: input.timeoutMs,
    });
    const appDiagnostics =
      appCommandResult.status === "failed" || appCommandResult.status === "timeout"
        ? appBuildFailureDiagnostics(appCommandResult.status)
        : undefined;
    moduleResults.push({
      modulePath: ".",
      moduleName: "app",
      command: "assembleApp",
      status: appCommandResult.status,
      exitCode: appCommandResult.exitCode,
      durationMs: appCommandResult.durationMs,
      stdoutExcerpt: appCommandResult.stdout,
      stderrExcerpt: appCommandResult.stderr,
      diagnostics: appDiagnostics,
    });
  }

  const failed = moduleResults.find((result) => result.status === "failed");
  const timedOut = moduleResults.find((result) => result.status === "timeout");
  const compiled = moduleResults.filter((result) => result.status !== "skipped");
  const status: HvigorBuildCheckStatus = timedOut
    ? "timeout"
    : failed
      ? "failed"
      : compiled.length > 0
        ? "success"
        : "skipped";
  const diagnostics =
    (failed?.command === "assembleApp" || timedOut?.command === "assembleApp"
      ? (failed ?? timedOut)?.diagnostics
      : undefined) ?? undefined;
  const summary = buildFinalSummary({
    enabled: true,
    status,
    hvigorRunDir: input.hvigorRunDir,
    checkedModules: modules,
    moduleResults,
    startedAt,
    diagnostics,
  });
  summary.deprecatedApiWarnings = collectDeprecatedApiWarnings({
    workspaceDir: input.workspaceDir,
    moduleResults,
    changedLineNumbersByFile: input.changedLineNumbersByFile,
  });
  summary.durationMs = Date.now() - startedAt;
  return applyCleanupPolicy(summary, input.workspaceDir, modules);
}

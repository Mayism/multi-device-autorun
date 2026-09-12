import fs from "node:fs/promises";
import path from "node:path";
import { verifyFileExists } from "./utils/file.js";
import { shellQuote } from "./utils/shellQuote.js";
import { rnPrepareCommands } from "./rn.js";
import { flutterPrepareCommands } from "./flutter.js";
import type {
  BuildCommand,
  BuildOutcome,
  CommandResult,
  ExecutionConfig,
} from "./types/index.js";

const BUILD_STDERR_TAIL_LINES = 15;

interface RunBuildInput {
  config: ExecutionConfig;
  skipBuild: boolean;
  runCommand: (command: string, cwd: string) => Promise<CommandResult>;
  diagnostics: string[];
}

export async function runBuild(input: RunBuildInput): Promise<BuildOutcome> {
  const started = Date.now();
  const commandFailure = await runBuildCommands(input, started);
  if (commandFailure) {
    return commandFailure;
  }
  return verifyBuildArtifacts(input, started);
}

async function verifyBuildArtifacts(
  input: RunBuildInput,
  started: number,
): Promise<BuildOutcome> {
  try {
    await verifyFileExists(input.config.artifacts.appHap);
    await verifyFileExists(input.config.artifacts.testHap);
  } catch (error) {
    input.diagnostics.push(
      `HAP 文件不存在：${error instanceof Error ? error.message : String(error)}`,
    );
    return blockedBuild(input.config, started, "hap_missing");
  }
  let hspPaths: string[];
  try {
    hspPaths = await resolveHspPaths(input.config);
  } catch (error) {
    input.diagnostics.push(
      `HSP 产物解析失败：${error instanceof Error ? error.message : String(error)}`,
    );
    return blockedBuild(input.config, started, "hap_missing");
  }
  return {
    result: {
      status: "passed",
      appHap: input.config.artifacts.appHap,
      testHap: input.config.artifacts.testHap,
      durationMs: Date.now() - started,
    },
    installArtifacts: {
      hspPaths,
      appHap: input.config.artifacts.appHap,
      testHap: input.config.artifacts.testHap,
    },
  };
}

async function runBuildCommands(
  input: RunBuildInput,
  started: number,
): Promise<BuildOutcome | undefined> {
  if (input.skipBuild) {
    return undefined;
  }
  for (const step of buildCommands(input.config)) {
    const result = await input.runCommand(step.command, step.cwd);
    if (result.exitCode !== 0) {
      input.diagnostics.push(`构建命令失败：${step.command}`);
      input.diagnostics.push(...tailOfStderr(result.stderr));
      return blockedBuild(input.config, started, "build_failed");
    }
  }
  return undefined;
}

function blockedBuild(
  config: ExecutionConfig,
  started: number,
  blockedReason: string,
): BuildOutcome {
  return {
    result: {
      status: "blocked",
      appHap: config.artifacts.appHap,
      testHap: config.artifacts.testHap,
      durationMs: Date.now() - started,
      blockedReason,
    },
  };
}

async function resolveHspPaths(config: ExecutionConfig): Promise<string[]> {
  const suffix = hspSignatureSuffix(config.artifacts.appHap);
  const hspPaths: string[] = [];
  for (const moduleInfo of config.sharedModules) {
    const entries = await fs.readdir(moduleInfo.outputDir, {
      withFileTypes: true,
    });
    const candidates = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => path.join(moduleInfo.outputDir, entry.name))
      .sort();
    if (candidates.length !== 1) {
      throw new Error(
        `shared module ${moduleInfo.name} expected exactly one ${suffix} file in ${moduleInfo.outputDir}; found ${candidates.length}: ${candidates.join(", ") || "none"}`,
      );
    }
    hspPaths.push(candidates[0]!);
  }
  return hspPaths;
}

function hspSignatureSuffix(appHap: string): "-unsigned.hsp" | "-signed.hsp" {
  if (appHap.endsWith("-unsigned.hap")) {
    return "-unsigned.hsp";
  }
  if (appHap.endsWith("-signed.hap")) {
    return "-signed.hsp";
  }
  throw new Error(
    `cannot determine HSP signature type from app HAP: ${appHap}`,
  );
}

export function buildTestHapCommand(config: ExecutionConfig): string {
  const buildExecutable = shellQuote(config.paths.hvigorw);
  return `${buildExecutable} --mode module -p module=${config.module}@ohosTest ${config.build.testTask} --no-daemon`;
}

function buildCommands(config: ExecutionConfig): BuildCommand[] {
  const packageManager = shellQuote(config.paths.ohpm);
  const buildExecutable = shellQuote(config.paths.hvigorw);
  const appBase = `${buildExecutable} --mode ${config.build.mode} -p product=${config.product}`;
  const appSuffix = "--analyze=normal --parallel --incremental --no-daemon";
  const testBase = `${buildExecutable} --mode module -p module=${config.module}@ohosTest`;
  const core: BuildCommand[] = [
    { command: `${packageManager} install`, cwd: config.project },
    { command: `${buildExecutable} clean --no-daemon`, cwd: config.project },
    {
      command: `${appBase} ${config.build.appTask} ${appSuffix}`,
      cwd: config.project,
    },
    {
      command: `${testBase} ${config.build.testTask} --no-daemon --stacktrace`,
      cwd: config.project,
    },
  ];
  if (!config.rn && !config.flutter) {
    return core;
  }
  if (config.flutter) {
    // flutter 只需在补丁后的每轮构建前刷新 Dart 依赖，hvigor 序列与 native 一致；
    // Dart 编译与引擎产物由 flutter-hvigor-plugin 在构建内完成。
    return [flutterPrepareCommands(config)[0]!, ...core];
  }
  const [ohpmInstall, clean, , testHap] = core;
  const [rnInstall, rnCodegen, ...rnBundleSteps] = rnPrepareCommands(config);
  return [
    rnInstall,
    ohpmInstall!,
    rnCodegen!,
    ...rnBundleSteps,
    clean!,
    {
      // RNOH 0.72 的 release 产物（assembleApp 项目模式默认 release + 混淆）会破坏
      // NAPI 按名解析，导致启动即崩（NapiBridge postMessageToCpp undefined）；
      // 模块模式 assembleHap 默认 debug，与 verify.sh 的已验证流程一致。
      command: `${buildExecutable} --mode module -p product=${config.product} assembleHap --no-daemon`,
      cwd: config.project,
    },
    testHap!,
  ];
}

function tailOfStderr(stderr: string): string[] {
  const trimmed = (stderr ?? "").trim();
  if (!trimmed) {
    return [];
  }
  const lines = trimmed.split(/\r?\n/);
  const tail = lines.slice(-BUILD_STDERR_TAIL_LINES);
  const prefix =
    lines.length > BUILD_STDERR_TAIL_LINES
      ? "[build stderr 尾部] "
      : "[build stderr] ";
  return [prefix + tail.join("\n")];
}

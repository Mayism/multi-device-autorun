import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { withDeviceLease } from "../device/device-lease.mjs";
import { resolveSharedToolchain } from "../config/toolchain.mjs";

const RESULT_POLL_INTERVAL_MS = 500;
const RESULT_EXIT_GRACE_MS = 10_000;
const FINAL_RESULT_STATUSES = new Set(["completed", "failed"]);
const RETAINED_WORKDIR_NAME = "ohostest-workdir";
const AUTORUN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const RUNNER_ROOT = path.join(AUTORUN_ROOT, "packages", "runner");
const DEFAULT_HDC_COMMAND = "hdc";
const DEFAULT_FOLD_SERVER_SCRIPT = path.join(
  RUNNER_ROOT,
  "src",
  "fold",
  "assets",
  "fold-server.py",
);

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function retainRunnerWorkdir(source, destination, attempts = 10, delayMs = 500) {
  if (!await exists(source)) return "";
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fsp.rename(source, destination);
      return destination;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

export async function loadOhosTestConfig(config) {
  const hasOhosTestConfig = Boolean(
    config.ohosTest
    && typeof config.ohosTest === "object"
    && !Array.isArray(config.ohosTest),
  );
  const raw = hasOhosTestConfig ? config.ohosTest : {};
  const enabled = hasOhosTestConfig && raw.enabled !== false;
  const timeoutSec = Math.max(1, Number(raw.timeoutSec) || 7200);
  const machineConfig = { ...raw };
  delete machineConfig.enabled;
  delete machineConfig.timeoutSec;
  const rawPaths = machineConfig.paths && typeof machineConfig.paths === "object"
    ? machineConfig.paths
    : {};
  const sharedToolchain = resolveSharedToolchain(config);
  const configuredFoldServerScript = String(rawPaths.foldServerScript || "").trim();
  const foldServerScript = configuredFoldServerScript
    ? path.resolve(config.__baseDir || process.cwd(), configuredFoldServerScript)
    : DEFAULT_FOLD_SERVER_SCRIPT;
  machineConfig.paths = {
    ...rawPaths,
    hvigorw: sharedToolchain.hvigorw,
    ohpm: sharedToolchain.ohpm,
    hdc: String(rawPaths.hdc || DEFAULT_HDC_COMMAND).trim(),
    foldServerScript,
  };

  const normalized = {
    enabled,
    runnerDir: RUNNER_ROOT,
    timeoutSec,
    machineConfig,
    runMode: "swe",
  };
  if (!enabled) return normalized;

  if (!Array.isArray(machineConfig.devices) || machineConfig.devices.length === 0) {
    throw new Error("ohosTest.enabled=true 时必须配置至少一个 ohosTest.devices 设备");
  }
  for (const [label, target] of [
    ["根 package.json", path.join(AUTORUN_ROOT, "package.json")],
    ["Runner package.json", path.join(RUNNER_ROOT, "package.json")],
    ["ohostest:case 入口", path.join(RUNNER_ROOT, "scripts", "runOhosTestCase.ts")],
  ]) {
    if (!await exists(target)) throw new Error(`${label} 不存在: ${target}`);
  }
  const packageJson = await readJson(path.join(RUNNER_ROOT, "package.json"));
  if (!packageJson?.scripts?.["ohostest:case"]) {
    throw new Error(`Runner 未定义 npm script ohostest:case: ${RUNNER_ROOT}`);
  }
  if (!await exists(path.join(AUTORUN_ROOT, "node_modules"))) {
    throw new Error(`工程依赖尚未安装，请先在工程根目录执行 npm install: ${AUTORUN_ROOT}`);
  }
  return { ...normalized, runnerVersion: String(packageJson.version || "") };
}

async function prepareGeneratedCase({ caseInfo, caseRunDir, patchPath }) {
  const sourceMetadataPath = path.join(caseInfo.caseRoot, "metadata.json");
  const sourceMetadata = await readJson(sourceMetadataPath);
  if (!sourceMetadata) throw new Error(`用例 metadata.json 不存在或不是合法 JSON: ${sourceMetadataPath}`);
  if (!sourceMetadata.base_project) throw new Error(`用例未配置 metadata.base_project: ${sourceMetadataPath}`);
  if (!sourceMetadata.test_patch) throw new Error(`用例未配置 metadata.test_patch: ${sourceMetadataPath}`);
  if (!sourceMetadata.golden_patch) throw new Error(`用例未配置 metadata.golden_patch: ${sourceMetadataPath}`);
  if (!await exists(patchPath)) throw new Error(`Agent 变更 patch 不存在: ${patchPath}`);

  const inputDir = caseRunDir;
  await fsp.mkdir(inputDir, { recursive: true });
  const projectName = String(caseInfo.projectName || "").trim();
  if (!new Set(["base", "task"]).has(projectName)) {
    throw new Error(`Agent 工程目录名必须是 base 或 task: ${projectName || "<empty>"}`);
  }
  const expectedProject = path.resolve(inputDir, projectName);
  const configuredProject = path.resolve(inputDir, String(sourceMetadata.base_project));
  if (configuredProject !== expectedProject) {
    throw new Error(
      `metadata.base_project 必须指向实际工程 ${projectName}: ${sourceMetadata.base_project}`,
    );
  }
  if (!await exists(expectedProject)) throw new Error(`Agent ${projectName} 工程不存在: ${expectedProject}`);

  const copyRelativeCaseFile = async (metadataValue, label) => {
    const relative = String(metadataValue || "").trim();
    const source = path.resolve(caseInfo.caseRoot, relative);
    const destination = path.resolve(inputDir, relative);
    const destinationRelative = path.relative(inputDir, destination);
    if (
      !relative
      || path.isAbsolute(relative)
      || path.isAbsolute(destinationRelative)
      || destinationRelative === ".."
      || destinationRelative.startsWith(`..${path.sep}`)
    ) {
      throw new Error(`metadata.${label} 必须是用例目录内的相对路径: ${relative}`);
    }
    if (!await exists(source)) throw new Error(`${label} 不存在: ${source}`);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(source, destination);
    return destination;
  };

  // 必须在 Agent 已完成后才调用本函数；先复制隐藏评测 patch，最后写入 metadata，
  // 避免 Agent 运行期间看到这些文件，也避免产生半就绪的 case 描述。
  const testPatchPath = await copyRelativeCaseFile(sourceMetadata.test_patch, "test_patch");
  const goldenPatchPath = await copyRelativeCaseFile(sourceMetadata.golden_patch, "golden_patch");
  const metadataPath = path.join(inputDir, "metadata.json");
  await fsp.copyFile(sourceMetadataPath, metadataPath);
  return { inputDir, metadataPath, testPatchPath, goldenPatchPath };
}

function runnerOutputDir(caseDir, startedAt) {
  const timestamp = startedAt.toISOString().replace(/[:.]/g, "-");
  return path.join(caseDir, ".ohostest-runs", `${timestamp}-${randomUUID().slice(0, 8)}`);
}

async function readFinalRunnerResult(resultPath) {
  const result = await readJson(resultPath);
  if (result?.schemaVersion !== "ohostest-case-v1") return null;
  return FINAL_RESULT_STATUSES.has(String(result.status || "")) ? result : null;
}

function npmInvocation(args) {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd", ...args],
    };
  }
  return { command: "npm", args };
}

async function terminateProcessTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await once(killer, "close").catch(() => {});
    return;
  }
  child.kill("SIGTERM");
}

async function runProcess({
  command,
  args,
  cwd,
  timeoutSec,
  signal,
  resultWatchPath,
  resultExitGraceMs = RESULT_EXIT_GRACE_MS,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stopReason = "";
    let timer;
    let resultPollTimer;
    let resultExitTimer;
    let checkingResult = false;
    let detectedResultStatus = "";
    let child;
    const clearTimers = () => {
      clearTimeout(timer);
      clearInterval(resultPollTimer);
      clearTimeout(resultExitTimer);
    };
    const finish = async (code, childSignal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      signal?.removeEventListener("abort", onAbort);
      resolve({
        code,
        signal: childSignal || "",
        stopReason,
        resultDetected: Boolean(detectedResultStatus),
        resultStatus: detectedResultStatus,
      });
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const stop = async (reason) => {
      if (settled || stopReason) return;
      stopReason = reason;
      await terminateProcessTree(child);
    };
    const onAbort = () => stop("Autorun 中断，正在终止 ohosTest 进程树").catch(() => {});
    const stopAfterFinalResult = async () => {
      if (settled || stopReason) return;
      stopReason = `ohosTest 已生成最终 result.json（status=${detectedResultStatus}），但进程在 ${Math.round(resultExitGraceMs / 1000)} 秒内未退出，正在终止进程树`;
      await terminateProcessTree(child);
      if (settled) return;

      // 最终结果已经写出且 Runner 已完成设备清理，主动结算本次运行，避免仍未退出
      // 的 npm/Runner 后代阻塞串行队列。
      child.stdout?.destroy();
      child.stderr?.destroy();
      await finish(child.exitCode, child.signalCode);
    };
    const checkFinalResult = async () => {
      if (settled || stopReason || checkingResult || detectedResultStatus || !resultWatchPath) return;
      checkingResult = true;
      try {
        const result = await readFinalRunnerResult(resultWatchPath);
        if (settled || !result) return;
        detectedResultStatus = String(result.status);
        clearInterval(resultPollTimer);
        resultExitTimer = setTimeout(
          () => stopAfterFinalResult().catch(() => {}),
          resultExitGraceMs,
        );
        resultExitTimer.unref?.();
      } finally {
        checkingResult = false;
      }
    };

    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        stdio: "ignore",
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", fail);
    child.once("close", (code, childSignal) => finish(code, childSignal).catch(fail));
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
    timer = setTimeout(
      () => stop(`ohosTest 总运行时间超过 ${timeoutSec} 秒`).catch(() => {}),
      timeoutSec * 1000,
    );
    timer.unref?.();
    if (resultWatchPath) {
      resultPollTimer = setInterval(
        () => checkFinalResult().catch(() => {}),
        RESULT_POLL_INTERVAL_MS,
      );
      resultPollTimer.unref?.();
      void checkFinalResult();
    }
  });
}

async function runPreparedOhosTest({ settings, caseInfo, caseRunDir, deviceLeasePath, signal, startedAt, stagedCase }) {
  const { inputDir } = stagedCase;
  const runnerWorkDir = path.join(inputDir, "work");
  const retainedWorkDir = path.join(inputDir, RETAINED_WORKDIR_NAME);
  await Promise.all([
    fsp.rm(runnerWorkDir, { recursive: true, force: true }),
    fsp.rm(retainedWorkDir, { recursive: true, force: true }),
  ]);
  const outputDir = runnerOutputDir(inputDir, startedAt);
  const resultWatchPath = path.join(outputDir, "result.json");
  const machineConfigPath = path.join(outputDir, "machine.json");
  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.writeFile(
    machineConfigPath,
    `${JSON.stringify(settings.machineConfig, null, 2)}\n`,
    "utf8",
  );
  const npmArgs = [
    "run",
    "--silent",
    "ohostest:case",
    "--",
    "--case",
    inputDir,
    "--out",
    outputDir,
    "--machine-config",
    machineConfigPath,
    "--run",
    settings.runMode,
    "--keep-emulators",
    "false",
    "--keep-workdir",
    "true",
  ];
  const invocation = npmInvocation(npmArgs);
  let processResult;
  let workPreserveError = "";
  try {
    processResult = await withDeviceLease({
      lockPath: deviceLeasePath,
      owner: `ohosTest:${caseInfo.name}`,
      timeoutSec: settings.timeoutSec,
      signal,
    }, () => runProcess({
      ...invocation,
      cwd: settings.runnerDir,
      timeoutSec: settings.timeoutSec,
      signal,
      resultWatchPath,
    }));
  } finally {
    try {
      await retainRunnerWorkdir(runnerWorkDir, retainedWorkDir);
    } catch (error) {
      workPreserveError = error instanceof Error ? error.message : String(error);
    }
  }
  const finishedAt = new Date();
  const runnerResultPath = await exists(resultWatchPath) ? resultWatchPath : "";
  const summaryCandidate = path.join(outputDir, "summary.md");
  const runnerSummaryPath = await exists(summaryCandidate) ? summaryCandidate : "";
  const runnerResult = await readJson(runnerResultPath);
  const workDir = await exists(retainedWorkDir)
    ? retainedWorkDir
    : await exists(runnerWorkDir)
      ? runnerWorkDir
      : "";
  const timedOut = processResult.stopReason.includes("总运行时间超过");
  const interrupted = processResult.stopReason.includes("Autorun 中断");
  const completed = runnerResult?.status === "completed";
  const status = completed ? "completed" : timedOut ? "timed_out" : interrupted ? "interrupted" : "failed";
  const diagnostic = runnerResult?.diagnostics?.[0]
    || processResult.stopReason
    || (processResult.code !== 0
      ? `ohostest:case 退出码 ${processResult.code}`
      : `ohostest:case 未在 ${path.join(inputDir, ".ohostest-runs")} 生成 completed 结果`);

  return {
    status,
    runnerStatus: runnerResult?.status || "",
    runnerVersion: settings.runnerVersion || "",
    runMode: settings.runMode,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedSec: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
    exitCode: processResult.code,
    signal: processResult.signal,
    error: completed ? "" : String(diagnostic),
    inputCaseDir: inputDir,
    metadataPath: stagedCase.metadataPath,
    machineConfigPath,
    testPatchPath: stagedCase.testPatchPath,
    outputDir,
    resultPath: runnerResultPath,
    summaryPath: runnerSummaryPath,
    workDir,
    ...(workPreserveError ? { workPreserveError } : {}),
  };
}

export async function runOhosTest({ settings, caseInfo, caseRunDir, patchPath, deviceLeasePath, signal }) {
  const startedAt = new Date();
  const stagedCase = await prepareGeneratedCase({ caseInfo, caseRunDir, patchPath });
  try {
    return await runPreparedOhosTest({
      settings,
      caseInfo,
      caseRunDir,
      deviceLeasePath,
      signal,
      startedAt,
      stagedCase,
    });
  } finally {
    await fsp.rm(stagedCase.goldenPatchPath, { force: true }).catch(() => {});
  }
}

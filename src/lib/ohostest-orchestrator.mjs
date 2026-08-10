import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { withDeviceLease } from "./device-lease.mjs";

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

export async function loadOhosTestConfig(config) {
  const raw = config.ohosTest || {};
  const enabled = raw.enabled === true;
  const runnerRoot = raw.runnerRoot
    ? path.resolve(config.__baseDir || process.cwd(), raw.runnerRoot)
    : "";
  const timeoutSec = Math.max(1, Number(raw.timeoutSec) || 7200);
  const machineConfig = runnerRoot
    ? path.resolve(runnerRoot, raw.machineConfig || path.join("config", "machine.json"))
    : "";

  const normalized = {
    enabled,
    runnerRoot,
    timeoutSec,
    machineConfig,
    runMode: "swe",
  };
  if (!enabled) return normalized;

  if (!runnerRoot) {
    throw new Error("ohosTest.enabled=true 时必须配置 ohosTest.runnerRoot");
  }
  for (const [label, target] of [
    ["Runner package.json", path.join(runnerRoot, "package.json")],
    ["ohostest:case 入口", path.join(runnerRoot, "scripts", "runOhosTestCase.ts")],
    ["设备配置", machineConfig],
  ]) {
    if (!await exists(target)) throw new Error(`${label} 不存在: ${target}`);
  }
  const packageJson = await readJson(path.join(runnerRoot, "package.json"));
  if (!packageJson?.scripts?.["ohostest:case"]) {
    throw new Error(`Runner 未定义 npm script ohostest:case: ${runnerRoot}`);
  }
  if (!await exists(path.join(runnerRoot, "node_modules"))) {
    throw new Error(`Runner 依赖尚未安装，请先在该目录执行 npm install: ${runnerRoot}`);
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

async function findLatestRunnerOutput(caseDir, startedAtMs) {
  const runsRoot = path.join(caseDir, ".ohostest-runs");
  if (!await exists(runsRoot)) return null;
  const entries = await fsp.readdir(runsRoot, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const outputDir = path.join(runsRoot, entry.name);
    const resultPath = path.join(outputDir, "result.json");
    if (!await exists(resultPath)) continue;
    const stat = await fsp.stat(resultPath);
    if (stat.mtimeMs + 2000 < startedAtMs) continue;
    candidates.push({ outputDir, resultPath, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] || null;
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

async function runProcess({ command, args, cwd, consolePath, timeoutSec, signal }) {
  await fsp.mkdir(path.dirname(consolePath), { recursive: true });
  return new Promise((resolve, reject) => {
    const log = fs.createWriteStream(consolePath, { flags: "a", encoding: "utf8" });
    log.write(`[${new Date().toISOString()}] ${command} ${args.join(" ")}\n`);

    let settled = false;
    let stopReason = "";
    let timer;
    let child;
    const stop = async (reason) => {
      if (settled || stopReason) return;
      stopReason = reason;
      log.write(`[${new Date().toISOString()}] ${reason}\n`);
      await terminateProcessTree(child);
    };
    const onAbort = () => stop("Autorun 中断，正在终止 ohosTest 进程树").catch(() => {});

    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      log.end();
      reject(error);
      return;
    }
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      log.end();
      reject(error);
    });
    child.once("close", async (code, childSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      log.end();
      await once(log, "finish").catch(() => {});
      resolve({ code, signal: childSignal || "", stopReason });
    });
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
  });
}

export async function runOhosTest({ settings, caseInfo, caseRunDir, patchPath, deviceLeasePath, signal }) {
  const startedAt = new Date();
  const stagedCase = await prepareGeneratedCase({ caseInfo, caseRunDir, patchPath });
  const { inputDir } = stagedCase;
  const runnerWorkDir = path.join(inputDir, "work");
  await fsp.rm(runnerWorkDir, { recursive: true, force: true });
  const consolePath = path.join(caseRunDir, "ohostest-runner-console.log");
  const npmArgs = [
    "run",
    "--silent",
    "ohostest:case",
    "--",
    "--case",
    inputDir,
    "--run",
    settings.runMode,
    "--keep-emulators",
    "false",
    "--keep-workdir",
    "false",
  ];
  const invocation = npmInvocation(npmArgs);
  let processResult;
  let workCleanupError = "";
  try {
    processResult = await withDeviceLease({
      lockPath: deviceLeasePath,
      owner: `ohosTest:${caseInfo.name}`,
      timeoutSec: settings.timeoutSec,
      signal,
    }, () => runProcess({
      ...invocation,
      cwd: settings.runnerRoot,
      consolePath,
      timeoutSec: settings.timeoutSec,
      signal,
    }));
  } finally {
    try {
      await fsp.rm(runnerWorkDir, { recursive: true, force: true });
    } catch (error) {
      workCleanupError = error instanceof Error ? error.message : String(error);
    }
  }
  const finishedAt = new Date();
  const generatedOutput = await findLatestRunnerOutput(inputDir, startedAt.getTime());
  const outputDir = generatedOutput?.outputDir || path.join(inputDir, ".ohostest-runs");
  const runnerResultPath = generatedOutput?.resultPath || "";
  const runnerSummaryPath = generatedOutput ? path.join(outputDir, "summary.md") : "";
  const runnerResult = await readJson(runnerResultPath);
  const timedOut = processResult.stopReason.includes("总运行时间超过");
  const interrupted = processResult.stopReason.includes("Autorun 中断");
  const completed = processResult.code === 0 && runnerResult?.status === "completed";
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
    runnerRoot: settings.runnerRoot,
    runMode: settings.runMode,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedSec: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
    exitCode: processResult.code,
    signal: processResult.signal,
    error: completed ? "" : String(diagnostic),
    inputCaseDir: inputDir,
    metadataPath: stagedCase.metadataPath,
    testPatchPath: stagedCase.testPatchPath,
    goldenPatchPath: stagedCase.goldenPatchPath,
    outputDir,
    resultPath: runnerResultPath,
    summaryPath: runnerSummaryPath,
    consolePath,
    ...(workCleanupError ? { workCleanupError } : {}),
  };
}

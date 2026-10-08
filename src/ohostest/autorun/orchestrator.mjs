import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { withDeviceLease } from "./device-lease.mjs";
import {
  checkConfiguredEmulatorPorts,
  formatEmulatorPortConflict,
} from "../../platform/emulator-hdc-port-check.mjs";
import { detectRnProject } from "../../shared/rn-project-detect.mjs";

const RESULT_POLL_INTERVAL_MS = 500;
const RESULT_EXIT_GRACE_MS = 10_000;
const FINAL_RESULT_STATUSES = new Set(["completed", "failed"]);
const RETAINED_WORKDIR_NAME = "ohostest-workdir";
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(MODULE_ROOT, "..", "..");

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

// rename 带重试：Windows 上进程树刚退出时，hvigor daemon 等子进程释放 work 目录
// 句柄可能有延迟（EBUSY/EPERM），短暂重试后通常即可移动。
async function renameWithRetry(source, destination, attempts = 10, delayMs = 500) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fsp.rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

async function retainRunnerWorkdir(source, destination, attempts = 10, delayMs = 500) {
  if (!await exists(source)) return "";
  await renameWithRetry(source, destination, attempts, delayMs);
  return destination;
}

// 目录联接：Windows 用 Junction（无需符号链接权限），其他平台用相对符号链接。
async function createDirLink(target, linkPath) {
  if (process.platform === "win32") {
    await fsp.symlink(path.win32.resolve(target), linkPath, "junction");
    return;
  }
  const relativeTarget = path.relative(path.dirname(linkPath), target) || ".";
  await fsp.symlink(relativeTarget, linkPath, "dir");
}

// RN 迁移运行的 work 保留：同卷 rename 到稳定目录（瞬时），再在 caseRunDir 下以
// 目录联接指向它，报告/打包看到的仍是 <caseRunDir>/ohostest-workdir。
// work 源路径是 <out>/work/project（runner 构建目录，out 在短根，与稳定目录同卷）。
// 返回保留模式："" 无 work；"stable" 移入稳定目录；"inPlace" work 被占用移不动，
// 联接直接指向 out 内的 work/project（调用方据此保留整个 out 目录、跳过迁回，
// 绝不退化为跨卷复制大 work 目录）。
async function retainRelocatedWorkdir({ rnWorkRoot, caseName, runnerWorkDir, retainedWorkDir }) {
  if (!await exists(runnerWorkDir)) return "";
  await fsp.mkdir(rnWorkRoot, { recursive: true });
  const stableDir = path.join(rnWorkRoot, `${safeWorkSegment(caseName)}__retained`);
  let inPlace = false;
  try {
    await fsp.rm(stableDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    await renameWithRetry(runnerWorkDir, stableDir);
  } catch {
    inPlace = true;
  }
  const linkTarget = inPlace ? runnerWorkDir : stableDir;
  await fsp.rm(retainedWorkDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  await createDirLink(linkTarget, retainedWorkDir);
  if (inPlace) {
    console.warn(`[ohosTest] ${caseName}: work 目录被占用无法移入稳定目录，ohostest-workdir 联接原地指向 ${runnerWorkDir}`);
  }
  return inPlace ? "inPlace" : "stable";
}

// 迁移到短根的输出目录迁回 caseRunDir/.ohostest-runs/<ts>：必须在 runner 进程树
// 完全退出之后调用（runProcess 于 close 后才 resolve），且 work/project 已被
// retainRelocatedWorkdir 移走，剩余为报告等小文件——跨卷降级复制也绝不会涉及
// 过大的 work 目录。优先同卷 rename（瞬时），跨卷递归复制后删除源目录。
async function restoreRelocatedOutput(outputDir, caseRunDir, startedAt) {
  const destination = runnerOutputDir(caseRunDir, startedAt);
  if (!await exists(outputDir)) return destination;
  await fsp.rm(destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  try {
    await fsp.rename(outputDir, destination);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await fsp.cp(outputDir, destination, { recursive: true, force: true, errorOnExist: true });
    await fsp.rm(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
  return destination;
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
  const runnerEnv = { ...process.env };
  const sdkHome = String(config.server?.sdkHome || "").trim();
  const javaHome = String(config.server?.javaHome || "").trim();
  if (sdkHome) {
    runnerEnv.DEVECO_SDK_HOME = sdkHome;
    runnerEnv.HOS_SDK_HOME = sdkHome;
    runnerEnv.OHOS_SDK_HOME = sdkHome;
  }
  if (javaHome) runnerEnv.JAVA_HOME = javaHome;
  const machineConfig = { ...raw };
  delete machineConfig.enabled;
  delete machineConfig.timeoutSec;
  delete machineConfig.rnWorkRoot;
  // RN 用例构建目录迁移根：显式配置优先（任意平台生效）；未配置时仅 Windows 默认
  // 启用数据盘短根；配置为 false 可显式关闭。
  const rawRnWorkRoot = raw.rnWorkRoot;
  let rnWorkRoot = "";
  if (typeof rawRnWorkRoot === "string" && rawRnWorkRoot.trim()) {
    rnWorkRoot = path.resolve(config.__baseDir || process.cwd(), rawRnWorkRoot.trim());
  } else if (rawRnWorkRoot !== false && process.platform === "win32") {
    rnWorkRoot = path.win32.join("D:", "mda-rn-work");
  }
  if (machineConfig.paths && typeof machineConfig.paths === "object") {
    machineConfig.paths = { ...machineConfig.paths };
    const foldServerScript = String(machineConfig.paths.foldServerScript || "").trim();
    if (foldServerScript && !path.isAbsolute(foldServerScript)) {
      machineConfig.paths.foldServerScript = path.resolve(
        config.__baseDir || process.cwd(),
        foldServerScript,
      );
    }
  }

  const normalized = {
    enabled,
    runnerDir: REPO_ROOT,
    timeoutSec,
    rnWorkRoot,
    machineConfig,
    runnerEnv,
    runMode: "swe",
  };
  if (!enabled) return normalized;

  if (!machineConfig.paths || typeof machineConfig.paths !== "object") {
    throw new Error("ohosTest.enabled=true 时必须配置 ohosTest.paths");
  }
  if (!Array.isArray(machineConfig.devices) || machineConfig.devices.length === 0) {
    throw new Error("ohosTest.enabled=true 时必须配置至少一个 ohosTest.devices 设备");
  }
  for (const [label, target] of [
    ["工程 package.json", path.join(REPO_ROOT, "package.json")],
    ["ohosTest 模块 package.json", path.join(MODULE_ROOT, "package.json")],
    ["ohostest:case 入口", path.join(MODULE_ROOT, "scripts", "runOhosTestCase.ts")],
  ]) {
    if (!await exists(target)) throw new Error(`${label} 不存在: ${target}`);
  }
  const rootPackageJson = await readJson(path.join(REPO_ROOT, "package.json"));
  const runnerPackageJson = await readJson(path.join(MODULE_ROOT, "package.json"));
  if (!rootPackageJson?.scripts?.["ohostest:case"]) {
    throw new Error(`工程根 package.json 未定义 npm script ohostest:case: ${REPO_ROOT}`);
  }
  if (!await exists(path.join(REPO_ROOT, "node_modules"))) {
    throw new Error(`工程依赖尚未安装，请在工程根目录执行 npm install: ${REPO_ROOT}`);
  }
  const portConflicts = await checkConfiguredEmulatorPorts(machineConfig);
  if (portConflicts.length > 0) {
    throw new Error([
      "模拟器 HDC 端口检查失败",
      ...portConflicts.map(formatEmulatorPortConflict),
    ].join("；"));
  }
  return { ...normalized, runnerVersion: String(runnerPackageJson?.version || "") };
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

// 与 autorun 批次 ID 同格式：本地时间 yyyymmddHHmmss
function batchLocalTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function runnerOutputDir(caseDir, startedAt) {
  return path.join(caseDir, ".ohostest-runs", batchLocalTimestamp(startedAt));
}

function safeWorkSegment(value) {
  return String(value || "case").replace(/[^0-9A-Za-z._-]+/g, "_").slice(0, 80) || "case";
}

// 准备迁移输出目录：临时目录路径越短越好，优先复用固定短路径 <rnWorkRoot>/<caseName>。
// 先清理本用例的历史残留（上次崩溃遗留的时间戳变体；__retained 是 workdir 联接
// 目标，保留）；固定路径存在且清不掉（文件被占用等）时，才退回加时间戳的变体区分。
async function prepareRelocatedOutDir(rnWorkRoot, caseName, startedAt) {
  const segment = safeWorkSegment(caseName);
  const primary = path.join(rnWorkRoot, segment);
  await sweepRelocatedOutDirs(rnWorkRoot, caseName);
  try {
    await fsp.rm(primary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {
    const variant = path.join(rnWorkRoot, `${segment}__${batchLocalTimestamp(startedAt)}`);
    console.warn(`[ohosTest] ${caseName}: 短路径 ${primary} 清理失败，本次运行改用 ${variant}`);
    return variant;
  }
  return primary;
}

// 清理同一用例在迁移根下遗留的历史迁移输出目录变体（上次运行崩溃等场景），失败忽略。
// 保留 __retained 稳定目录（ohostest-workdir 联接指向它）。
async function sweepRelocatedOutDirs(rnWorkRoot, caseName) {
  const prefix = `${safeWorkSegment(caseName)}__`;
  const retainedName = `${safeWorkSegment(caseName)}__retained`;
  let entries;
  try {
    entries = await fsp.readdir(rnWorkRoot);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix) && entry !== retainedName)
      .map((entry) => fsp.rm(path.join(rnWorkRoot, entry), { recursive: true, force: true }).catch(() => {})),
  );
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
  env,
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
        env,
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

async function runPreparedOhosTest({ settings, caseInfo, caseRunDir, relocatedOut = "", deviceLeasePath, signal, startedAt, stagedCase }) {
  const { inputDir } = stagedCase;
  // runner 的构建目录是 <out>/work/project：RN 迁移时 --out 直接指向短根（D 盘）
  // 下的 relocatedOut，构建路径全程在短根，规避 Windows 259 字符限制；用例输入
  // 目录不变。保留目录与最终报告始终锚定 caseRunDir，迁移输出结束后整体迁回。
  const outputDir = relocatedOut || runnerOutputDir(inputDir, startedAt);
  // Archive the project root itself so native and Web layouts remain usable directly.
  const runnerWorkDir = path.join(outputDir, "work", "project");
  const retainedWorkDir = path.join(caseRunDir, RETAINED_WORKDIR_NAME);
  await Promise.all([
    fsp.rm(runnerWorkDir, { recursive: true, force: true }),
    fsp.rm(retainedWorkDir, { recursive: true, force: true }),
    fsp.rm(path.join(caseRunDir, "work"), { recursive: true, force: true }),
  ]);
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
      env: settings.runnerEnv,
      timeoutSec: settings.timeoutSec,
      signal,
      resultWatchPath,
    }));
  } finally {
    // runner 进程树已完全退出（runProcess 在 close 后才 resolve），此处才开始移动
    // 目录；work 被占用移不动时原地保留，绝不退化为跨卷复制大 work 目录。
    let retainMode = "";
    try {
      if (relocatedOut) {
        retainMode = await retainRelocatedWorkdir({
          rnWorkRoot: settings.rnWorkRoot,
          caseName: caseInfo.name,
          runnerWorkDir,
          retainedWorkDir,
        });
      } else {
        await retainRunnerWorkdir(runnerWorkDir, retainedWorkDir);
      }
    } catch (error) {
      workPreserveError = error instanceof Error ? error.message : String(error);
      retainMode = "error";
    }
    if (relocatedOut && retainMode !== "stable" && retainMode !== "") {
      stagedCase.keepRelocatedOut = true;
    }
  }
  const finishedAt = new Date();
  let finalOutputDir = outputDir;
  if (relocatedOut && !stagedCase.keepRelocatedOut) {
    // 迁移输出整体迁回 caseRunDir/.ohostest-runs/<ts>（work 已先移至短根稳定目录，
    // 剩余是报告等小文件）；保留失败时不动输出，报告继续指向短根路径兜底。
    try {
      finalOutputDir = await restoreRelocatedOutput(outputDir, caseRunDir, startedAt);
    } catch (error) {
      workPreserveError = workPreserveError
        || `迁移输出目录迁回失败: ${error instanceof Error ? error.message : String(error)}`;
      stagedCase.keepRelocatedOut = true;
    }
  }
  const resultPath = path.join(finalOutputDir, "result.json");
  const runnerResultPath = await exists(resultPath) ? resultPath : "";
  const summaryCandidate = path.join(finalOutputDir, "summary.md");
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
      : `ohostest:case 未在 ${finalOutputDir} 生成 completed 结果`);

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
    machineConfigPath: path.join(finalOutputDir, "machine.json"),
    testPatchPath: stagedCase.testPatchPath,
    outputDir: finalOutputDir,
    resultPath: runnerResultPath,
    summaryPath: runnerSummaryPath,
    workDir,
    ...(workPreserveError ? { workPreserveError } : {}),
  };
}

export async function runOhosTest({ settings, caseInfo, caseRunDir, patchPath, deviceLeasePath, signal }) {
  const startedAt = new Date();
  // 仅 RN 用例且配置了迁移根时，runner 的 --out 直接指向短根（D 盘）下的固定迁移
  // 输出目录，规避 Windows 259 字符路径限制；构建目录 <out>/work/project 全程在
  // 短根，用例输入不变，运行结束后产物迁回 caseRunDir，报告与打包路径不变。
  const isRnCase = Boolean(settings.rnWorkRoot)
    && await detectRnProject(path.join(caseRunDir, caseInfo.projectName));
  const relocatedOut = isRnCase
    ? await prepareRelocatedOutDir(settings.rnWorkRoot, caseInfo.name, startedAt)
    : "";
  if (relocatedOut) {
    console.log(`[ohosTest] ${caseInfo.name}: RN 工程，ohosTest 输出目录使用短路径 ${relocatedOut}，运行结束后产物迁回 ${caseRunDir}`);
  }
  const stagedCase = await prepareGeneratedCase({ caseInfo, caseRunDir, patchPath });
  try {
    return await runPreparedOhosTest({
      settings,
      caseInfo,
      caseRunDir,
      relocatedOut,
      deviceLeasePath,
      signal,
      startedAt,
      stagedCase,
    });
  } finally {
    await fsp.rm(stagedCase.goldenPatchPath, { force: true }).catch(() => {});
    if (relocatedOut && !stagedCase.keepRelocatedOut) {
      // 正常/异常/手动停止路径统一在此清理临时目录：产物已迁回（rename 整体移走
      // 或跨卷复制后删除），此处兜底删除失败残留；无法清理的留待下次运行重试。
      await fsp.rm(relocatedOut, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
    }
  }
}

// cloudtest-orchestrator.mjs
// 云测试编排：按步骤拆分为独立函数，由 runCloudTest 串联。
//   prepareAppArtifact   解析待测包（构建签名 .app 或直接使用 --app）
//   computeAppDigest     读取包内容并计算 sha256/大小
//   queryExistingPackages 查询云端历史已上传包（暂不删除，仅记录）
//   uploadAndAnalyzeApp  申请 OBS 凭证 → 直传 → 等待云端解析
//   selectCloudDevices   查询 business/device/list 真机列表并按空闲程度排序
//   submitWithDeviceFallback 配额预检 + 按候选顺序逐台尝试提交任务
//   pollTaskGroup        轮询任务组状态直到完成/超时/中断
// 接口细节见 cloudtest-client.mjs；指令入口见 autorun.mjs 的 --cloud-test。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { CloudTestClient } from "./cloudtest-client.mjs";
import { readLooseJson5 } from "../shared/json5-lite.mjs";

// 任务组 status：1 待执行 / 2 执行中；3、4、5、6 均视为已完成（终态）。
// 另外 resultStatus 非零（已出结果）也直接视为完成，不必等 status 变终态。
const TASKGROUP_FINAL_STATUSES = new Set([3, 4, 5, 6]);
const TASKGROUP_STATUS_LABELS = {
  1: "待执行",
  2: "执行中",
  3: "已完成",
  4: "已完成",
  5: "已完成",
  6: "已完成",
};

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function atomicWriteJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, filePath);
}

function interruptionError(reason = "云测试执行被中断") {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  error.code ||= "AUTORUN_INTERRUPTED";
  return error;
}

function throwIfInterrupted(signal) {
  if (signal?.aborted) throw interruptionError(signal.reason);
}

function timestampName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// ============================================================
// 配置与工程信息
// ============================================================

export function loadCloudTestConfig(config) {
  const raw = config.cloudTest || {};
  // cookie 来源优先级：显式 cookieFile > 配置目录下自动探测的 agc-cookie.txt
  // > cloudTest.agcAuthInfo > 环境变量 AGC_AUTH_INFO。
  // cookie 文件是纯文本单行整行 cookie（浏览器复制后原样粘贴，无需 JSON 转义）。
  const baseDir = config.__baseDir || process.cwd();
  const DEFAULT_COOKIE_FILE = "agc-cookie.txt";
  let cookieFile = "";
  const defaultCookieFile = path.join(baseDir, DEFAULT_COOKIE_FILE);
  if (fs.existsSync(defaultCookieFile)) cookieFile = defaultCookieFile;
  let fileCookie = "";
  if (cookieFile) {
    if (!fs.existsSync(cookieFile)) {
      throw new Error(`cloudTest.cookieFile 不存在: ${cookieFile}`);
    }
    fileCookie = fs.readFileSync(cookieFile, "utf8").replace(/[\r\n]+/g, "").trim();
  }
  // 测试类别配置：每项 { category, timeSpan }，未配置时使用默认值。
  const rawCategories = Array.isArray(raw.testCategories) && raw.testCategories.length
    ? raw.testCategories
    : [{ category: 24, timeSpan: 60 }];
  const testCategories = rawCategories.map((item) => ({
    category: Number(item?.category) || 24,
    timeSpan: Math.max(1, Number(item?.timeSpan) || 60),
  }));
  const normalized = {
    // 云测试默认属于主流程的一部分；关闭后批次不执行云测试，独立指令也不可用
    enabled: raw.enabled !== false,
    cookieFile,
    teamId: String(raw.teamId || process.env.AGC_TEAM_ID || "").trim(),
    projectId: String(raw.projectId || process.env.AGC_PROJECT_ID || "").trim(),
    agcAuthInfo: String(fileCookie || process.env.AGC_AUTH_INFO || "").trim(),
    // 工具路径为 server 下的扁平键（与 devecoHome 同级）：
    // hvigorw/ohpm 为本机命令（PATH 裸命令或绝对路径，可含参数前缀如
    // "node /…/hvigorw.js"），未配置则复用 ohosTest.paths 已有键，再退到 PATH 裸命令；
    // sdkHome/javaHome 可选，设置后注入 DEVECO_SDK_HOME/JAVA_HOME，
    // 未设置则继承当前进程环境。
    paths: (() => {
      const server = config.server && typeof config.server === "object" ? config.server : {};
      const ohosPaths = config.ohosTest?.paths && typeof config.ohosTest.paths === "object" ? config.ohosTest.paths : {};
      return {
        hvigorw: String(server.hvigorw || ohosPaths.hvigorw || "hvigorw").trim(),
        ohpm: String(server.ohpm || ohosPaths.ohpm || "ohpm").trim(),
        sdkHome: String(server.sdkHome || "").trim(),
        javaHome: String(server.javaHome || "").trim(),
      };
    })(),
    product: String(raw.product || "default"),
    buildMode: String(raw.buildMode || "release"),
    buildTimeoutSec: Math.max(60, Number(raw.buildTimeoutSec) || 1800),
    analyzeTimeoutSec: Math.max(30, Number(raw.analyzeTimeoutSec) || 900),
    testCategories,
    appClass: String(raw.appClass || "Tool"),
    // 补充签名：待测工程通常不带签名信息，打包前注入。
    // bundleName 替换 AppScope/app.json5 的 bundleName（需与签名 profile 匹配）；
    // signingConfigs 整体替换 build-profile.json5 的 app.signingConfigs。
    bundleName: String(raw.bundleName || "").trim(),
    // 签名材料路径支持相对路径（相对 config 目录解析），便于证书随仓库提交
    signingConfigs: (Array.isArray(raw.signingConfigs) ? raw.signingConfigs : []).map((item) => {
      if (!item || typeof item !== "object") return item;
      const material = { ...(item.material || {}) };
      for (const key of ["storeFile", "profile", "certpath"]) {
        const value = String(material[key] || "").trim();
        if (value && !path.isAbsolute(value)) {
          material[key] = path.resolve(config.__baseDir || process.cwd(), value);
        }
      }
      return { ...item, material };
    }),
    taskType: Number(raw.taskType) || 28,
    testItem: String(raw.testItem || "17179869185"),
    pollIntervalSec: Math.max(5, Number(raw.pollIntervalSec) || 60),
    taskTimeoutSec: Math.max(60, Number(raw.taskTimeoutSec) || 7200),
    // OBS 直传代理（http://host:port），AGC 接口与 refresh 始终直连；也可用环境变量 AGC_PROXY。
    // 配置代理时 OBS 上传默认跳过证书校验（兼容企业 MITM 自签证书），无额外配置项。
    proxy: String(raw.proxy || process.env.AGC_PROXY || "").trim(),
  };
  const missing = [
    ["teamId", normalized.teamId],
    ["projectId", normalized.projectId],
    ["agcAuthInfo", normalized.agcAuthInfo],
  ].filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) {
    throw new Error(`cloudTest 配置不完整，缺少: ${missing.join(", ")}（请在 config 中补齐或设置环境变量 AGC_TEAM_ID / AGC_PROJECT_ID / AGC_AUTH_INFO）`);
  }
  return normalized;
}

/** 读取工程的 bundleName/versionName，并检查签名配置是否就绪。 */
export async function readAppProfile(projectDir) {
  const appJsonPath = path.join(projectDir, "AppScope", "app.json5");
  if (!await exists(appJsonPath)) {
    throw new Error(`未找到 AppScope/app.json5，不是 HarmonyOS 工程根目录: ${projectDir}`);
  }
  const profile = await readLooseJson5(appJsonPath);
  const app = profile?.app || {};
  const bundleName = String(app.bundleName || "").trim();
  const versionName = String(app.versionName || "").trim();
  if (!bundleName || !versionName) {
    throw new Error(`AppScope/app.json5 缺少 bundleName 或 versionName: ${appJsonPath}`);
  }

  const buildProfilePath = path.join(projectDir, "build-profile.json5");
  let signingCount = 0;
  if (await exists(buildProfilePath)) {
    try {
      const buildProfile = await readLooseJson5(buildProfilePath);
      signingCount = Array.isArray(buildProfile?.app?.signingConfigs)
        ? buildProfile.app.signingConfigs.filter((item) => item && item.name).length
        : 0;
    } catch {
      signingCount = 0;
    }
  }
  return {
    bundleName,
    versionName,
    versionCode: app.versionCode,
    bundleType: String(app.bundleType || ""),
    hasSigningConfig: signingCount > 0,
    signingConfigCount: signingCount,
    buildProfilePath,
  };
}

// ============================================================
// 本地构建
// ============================================================

/** 运行外部命令，stdout/stderr 逐行追加到 consolePath 并回调 onLine。 */
/** 终止进程树（shell 执行时 kill 需覆盖子进程；与 ohostest-orchestrator 同一策略）。 */
async function terminateProcessTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    killer.once("error", () => {});
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // 进程可能已退出
  }
}

/** 以 shell 命令串运行外部命令，stdout/stderr 逐行追加到 consolePath 并回调 onLine。
 * commandLine 为完整命令（可含参数，由调用方保证引号），工具路径来自配置、经 PATH 或绝对路径解析。 */
async function runLogged({ commandLine, cwd, env, consolePath, onLine, timeoutMs, timeoutLabel, signal }) {
  await fsp.mkdir(path.dirname(consolePath), { recursive: true });
  const startedAt = new Date();
  const result = await new Promise((resolve, reject) => {
    fs.appendFileSync(consolePath, `\n[${startedAt.toISOString()}] ${commandLine}\n`, "utf8");
    const child = spawn(commandLine, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: true });
    const log = fs.createWriteStream(consolePath, { flags: "a", encoding: "utf8" });
    const append = (chunk) => {
      log.write(chunk);
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) onLine(line);
      }
    };
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      log.end();
      fn(value);
    };
    const onAbort = () => {
      terminateProcessTree(child);
      finish(reject, interruptionError(signal.reason));
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => finish(reject, error));
    child.once("close", (code) => finish(resolve, { code }));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      terminateProcessTree(child);
      finish(reject, new Error(`${timeoutLabel}超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    timer.unref?.();
  });
  return {
    command: commandLine,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode: result.code,
  };
}

/** shell 引号包裹（与 runner 的 shellQuote 同语义）：
 * 安全部件（字母数字与 _ . / : = @ % + , - 和反斜杠）不加引号，
 * 其余按平台加引号，避免含空格路径（如 "D:\deveco\DevEco Studio"）被 shell 截断。 */
function shellQuote(value) {
  const text = String(value ?? "");
  if (text === "") return '""';
  if (/^[A-Za-z0-9_.\/:=@%+,\\-]+$/.test(text)) return text;
  if (process.platform === "win32") {
    return '"' + text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
  }
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

/** 构建环境：sdkHome/javaHome 配置了才注入，未配置继承当前进程环境。 */
function buildEnv(paths) {
  const env = { ...process.env };
  if (paths.sdkHome) env.DEVECO_SDK_HOME = paths.sdkHome;
  if (paths.javaHome) env.JAVA_HOME = paths.javaHome;
  return env;
}

/** 依赖缺失时先执行 ohpm install，再运行 hvigor assembleApp 生成签名 .app。
 * 工具命令来自 settings.paths（配置 > ohosTest.paths > PATH 裸命令），
 * 以 shell 命令串执行；绝对路径命令会做存在性预检，PATH 命令由运行时解析。 */
async function buildSignedApp({ projectDir, settings, consolePath, onLine, signal }) {
  const paths = settings.paths;
  // hvigorw 语义：hvigorw.js 路径（自动以当前 node 运行）或可执行命令（PATH 裸命令/绝对路径）
  const hvigorwCommand = paths.hvigorw.endsWith(".js")
    ? `${shellQuote(process.execPath)} ${shellQuote(paths.hvigorw)}`
    : shellQuote(paths.hvigorw);
  for (const [label, command] of [["hvigorw", paths.hvigorw], ["ohpm", paths.ohpm]]) {
    if (path.isAbsolute(command) && !await exists(command)) {
      throw new Error(`${label} 配置的路径不存在: ${command}（检查 server.hvigorw / server.ohpm / ohosTest.paths）`);
    }
  }
  const env = buildEnv(paths);
  const steps = [];

  if (!await exists(path.join(projectDir, "oh_modules"))) {
    onLine(`工程缺少 oh_modules，先执行 ohpm install --all ...`);
    steps.push(await runLogged({
      commandLine: `${shellQuote(paths.ohpm)} install --all`,
      cwd: projectDir,
      env,
      consolePath,
      onLine,
      timeoutMs: settings.buildTimeoutSec * 1000,
      timeoutLabel: "ohpm install",
      signal,
    }));
    if (steps[steps.length - 1].exitCode !== 0) {
      throw new Error(`ohpm install 退出码 ${steps[steps.length - 1].exitCode}，日志: ${consolePath}`);
    }
  }

  steps.push(await runLogged({
    commandLine: [
      hvigorwCommand,
      "--mode", "project",
      "-p", `product=${settings.product}`,
      "-p", `buildMode=${settings.buildMode}`,
      "assembleApp",
      "--analyze=normal",
      "--parallel",
      "--incremental",
      "--no-daemon",
    ].join(" "),
    cwd: projectDir,
    env,
    consolePath,
    onLine,
    timeoutMs: settings.buildTimeoutSec * 1000,
    timeoutLabel: "构建",
    signal,
  }));
  return {
    steps,
    consolePath,
    exitCode: steps[steps.length - 1].exitCode,
  };
}

// 在 build 下的 outputs 目录中查找最新的签名 .app。
async function findSignedApp(projectDir) {
  const found = [];
  const outputsRoot = path.join(projectDir, "build");
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".app")) {
        const stat = await fsp.stat(full).catch(() => null);
        if (stat) found.push({ path: full, mtime: stat.mtimeMs, size: stat.size });
      }
    }
  }
  await walk(outputsRoot);
  if (!found.length) {
    throw new Error(`构建成功但未在 ${outputsRoot} 下找到 .app 产物`);
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const signed = found.filter((item) => /signed/i.test(path.basename(item.path)));
  if (!signed.length) {
    const names = found.map((item) => path.basename(item.path)).join(", ");
    throw new Error(`只找到未签名 .app（${names}）。请先在工程 build-profile.json5 中配置 release 签名（material/certpath/signAlg 等）后重试`);
  }
  return signed[0];
}

/**
 * 步骤 1+2：确定待上传的签名包。
 * - 指定 appPath 时校验存在性并尽量读取工程信息（不构建）；
 * - 否则读取工程信息、校验签名配置，复制到输出沙箱后构建。
 * @returns {Promise<{appPath: string, appProfile: object|null, build: object|null, app: object}>}
 */
async function prepareAppArtifact({ projectDir, appPath, settings, outDir, consolePath, signal, onLog }) {
  if (appPath) {
    if (!await exists(appPath)) throw new Error(`--app 文件不存在: ${appPath}`);
    const resolvedAppPath = path.resolve(appPath);
    let appProfile = null;
    if (projectDir) {
      appProfile = await readAppProfile(projectDir).catch(() => null);
      if (appProfile) {
        onLog(`bundleName=${appProfile.bundleName} versionName=${appProfile.versionName}（来自 ${projectDir}）`);
      }
    }
    onLog(`跳过构建，使用指定包: ${resolvedAppPath}`);
    return { appPath: resolvedAppPath, appProfile, build: null, app: appInfoForReport(appProfile, settings.bundleName) };
  }

  if (!projectDir) throw new Error("未指定工程目录（--case/--project-dir）或 .app 文件（--app）");
  const appProfile = await readAppProfile(projectDir);
  onLog(`工程: ${projectDir}`);
  onLog(`bundleName=${appProfile.bundleName} versionName=${appProfile.versionName} versionCode=${appProfile.versionCode} bundleType=${appProfile.bundleType || "-"}`);
  if (!appProfile.hasSigningConfig && !settings.signingConfigs.length) {
    throw new Error(
      `工程未配置签名且未提供补充签名：请在工程 build-profile.json5 配置 signingConfigs，`
      + `或在 config 的 cloudTest.signingConfigs 注入（同时可用 cloudTest.bundleName 替换包名以匹配签名 profile）`,
    );
  }

  throwIfInterrupted(signal);
  const { copyProject } = await import("../runtime/sandbox-copy.mjs");
  const buildProjectDir = path.join(outDir, "project");
  const buildStartedAt = new Date();
  onLog(`复制工程到构建沙箱: ${buildProjectDir}`);
  await copyProject(projectDir, buildProjectDir);
  await applySigningOverrides({ buildProjectDir, settings, onLog });
  onLog(`开始构建签名包（${settings.buildMode}/${settings.product}，最长 ${settings.buildTimeoutSec} 秒）...`);
  const build = await buildSignedApp({
    projectDir: buildProjectDir,
    settings,
    consolePath,
    onLine: (line) => { if (/\bERROR\b|Failed|fail/i.test(line)) onLog(`[build] ${line}`); },
    signal,
  });
  const buildInfo = {
    projectDir: buildProjectDir,
    sourceProjectDir: projectDir,
    startedAt: buildStartedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    ...build,
  };
  if (build.exitCode !== 0) {
    throw new Error(`hvigor assembleApp 退出码 ${build.exitCode}，日志: ${build.consolePath}`);
  }
  const artifact = await findSignedApp(buildProjectDir);
  onLog(`构建完成: ${path.basename(artifact.path)}（${(artifact.size / 1024 / 1024).toFixed(2)} MB）`);
  buildInfo.artifactPath = artifact.path;
  buildInfo.artifactSize = artifact.size;
  return { appPath: artifact.path, appProfile, build: buildInfo, app: appInfoForReport(appProfile, settings.bundleName) };
}

/**
 * 补充签名（作用于构建沙箱副本，不修改源工程）：
 * - settings.bundleName：替换 AppScope/app.json5 的 app.bundleName（需与签名 profile 匹配）；
 * - settings.signingConfigs：整体替换 build-profile.json5 的 app.signingConfigs，
 *   并为缺失 signingConfig 引用的 product 补上首个注入项的 name。
 * 沙箱文件以严格 JSON 重写（丢弃注释），仅影响本次构建产物。
 */
async function applySigningOverrides({ buildProjectDir, settings, onLog }) {
  if (settings.bundleName) {
    const appJsonPath = path.join(buildProjectDir, "AppScope", "app.json5");
    const parsed = await readLooseJson5(appJsonPath);
    if (!parsed?.app) throw new Error(`沙箱 AppScope/app.json5 缺少 app 节点: ${appJsonPath}`);
    const previous = parsed.app.bundleName || "";
    parsed.app.bundleName = settings.bundleName;
    await fsp.writeFile(appJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    onLog(`bundleName 已替换: ${previous || "<空>"} → ${settings.bundleName}`);
  }
  if (settings.signingConfigs.length) {
    const buildProfilePath = path.join(buildProjectDir, "build-profile.json5");
    const parsed = await readLooseJson5(buildProfilePath);
    if (!parsed?.app) throw new Error(`沙箱 build-profile.json5 缺少 app 节点: ${buildProfilePath}`);
    parsed.app.signingConfigs = settings.signingConfigs;
    const injectedNames = settings.signingConfigs.map((item) => String(item?.name || "")).filter(Boolean);
    for (const product of Array.isArray(parsed.app.products) ? parsed.app.products : []) {
      if (!product.signingConfig && injectedNames.length) {
        product.signingConfig = injectedNames[0];
      } else if (product.signingConfig && injectedNames.length && !injectedNames.includes(product.signingConfig)) {
        onLog(`[warn] product "${product.name}" 引用的 signingConfig "${product.signingConfig}" 不在注入配置（${injectedNames.join(",")}）中`);
      }
    }
    await fsp.writeFile(buildProfilePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    onLog(`signingConfigs 已注入 ${injectedNames.length} 项（${injectedNames.join(",")}），将使用 release 签名打包`);
  }
}

function appInfoForReport(appProfile, effectiveBundleName = "") {
  if (!appProfile) return {};
  return {
    bundleName: effectiveBundleName || appProfile.bundleName,
    versionName: appProfile.versionName,
    versionCode: appProfile.versionCode,
    bundleType: appProfile.bundleType,
  };
}

// ============================================================
// 云端步骤
// ============================================================

/**
 * 步骤 3：读取包内容并计算 sha256/大小。
 * @returns {Promise<{bytes: Buffer, fileName: string, fileSize: number, sha256: string}>}
 */
async function computeAppDigest(appPath) {
  const bytes = await fsp.readFile(appPath);
  return {
    bytes,
    fileName: path.basename(appPath),
    fileSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * 步骤 4：查询云端历史已上传包（暂不删除，仅记录与提示）。
 * @returns {Promise<{count: number, entries: object[]}>}
 */
async function queryExistingPackages({ client, bundleName, onLog }) {
  try {
    const apps = await client.listApps();
    const entries = bundleName
      ? apps.filter((item) => String(item.packageName || "") === bundleName)
      : [];
    if (entries.length) {
      const summary = entries
        .map((item) => `${item.appName || "?"}/${item.appVersion || "?"}(id=${item.id})`)
        .join("；");
      onLog(`云端已有同包名上传记录 ${entries.length} 条: ${summary}（暂不删除旧包，将直接重新上传）`);
    } else if (bundleName) {
      onLog("云端未发现同包名历史上传记录，直接上传新包");
    }
    return { count: entries.length, entries };
  } catch (error) {
    onLog(`[warn] 查询历史包列表失败（继续上传）: ${error.message}`);
    return { count: 0, entries: [] };
  }
}

/**
 * 步骤 5：申请 OBS 凭证 → 直传 → 触发并等待云端解析。
 * @returns {Promise<{upload: object, appInfo: object}>} upload 为 result.upload 内容（不含历史包计数）
 */
async function uploadAndAnalyzeApp({ client, digest, existingCount, settings, signal, onLog }) {
  throwIfInterrupted(signal);
  onLog(`申请上传凭证并直传 OBS: ${digest.fileName}（${(digest.fileSize / 1024 / 1024).toFixed(2)} MB）...`);
  const obs = await client.requestUploadUrl({
    fileName: digest.fileName,
    fileSize: digest.fileSize,
    sha256: digest.sha256,
  });
  await client.putObject(obs, digest.bytes);
  await client.triggerAnalyze(obs.objectId);
  const appInfo = await client.pollAnalyze(obs.objectId, {
    timeoutMs: settings.analyzeTimeoutSec * 1000,
    onProgress: onLog,
  });
  onLog(`云端解析完成: appName=${appInfo.appName} version=${appInfo.appVersion} appType=${appInfo.appType} apiLevel=${appInfo.geApiLevel} appInfoId=${appInfo.id}`);
  return {
    upload: {
      objectId: obs.objectId,
      fileName: digest.fileName,
      uploadedAt: new Date().toISOString(),
      existingSamePackageCount: existingCount,
      appInfoId: appInfo.id,
      appName: appInfo.appName,
      appVersion: appInfo.appVersion,
      packageName: appInfo.packageName,
      appType: appInfo.appType,
      geApiLevel: appInfo.geApiLevel,
      deviceKinds: appInfo.deviceKinds,
    },
    appInfo,
  };
}

/** 校验云端解析出的包名与本地 bundleName 是否一致（仅告警）。 */
function warnPackageMismatch({ appInfo, bundleName = "", onLog }) {
  if (bundleName && appInfo?.packageName && appInfo.packageName !== bundleName) {
    onLog(`[warn] 云端解析包名 ${appInfo.packageName} 与本地 bundleName ${bundleName} 不一致`);
  }
}

/** 设备列表排序：空闲设备在前、可排队设备在后、完全不可用垫底；同组内按等待时间升序。 */
function rankBusinessDevices(deviceList) {
  const groupOf = (device) => {
    if ((Number(device.idleDeviceCount) || 0) > 0) return 0; // 有空闲机器
    if ((Number(device.usableNumber) || 0) > 0) return 1; // 无空闲但可排队
    return 2; // 暂不可用
  };
  return [...deviceList].sort((a, b) =>
    groupOf(a) - groupOf(b)
    || (Number(a.waitTime) || 0) - (Number(b.waitTime) || 0)
    || (Number(b.idleDeviceCount) || 0) - (Number(a.idleDeviceCount) || 0)
    || (Number(b.usableNumber) || 0) - (Number(a.usableNumber) || 0));
}

/**
 * 步骤 6：查询可用真机列表并按空闲程度排序。
 * 查询条件全部来自云端包解析结果（appType / testCategories / apiLevels），
 * 不依赖本地机型配置；返回排序后的候选设备（空闲在前，排队在后）。
 * @returns {Promise<object[]>}
 */
async function selectCloudDevices({ client, appInfo, settings, onLog }) {
  const deviceList = await client.listBusinessDevices({
    appType: appInfo.appType,
    // 设备列表接口要逗号分隔的类别数字（testCategories=24,25）；
    // [{category,timeSpan}] 对象结构仅用于配额预检与任务提交的 testCategoryLists
    testCategories: settings.testCategories.map((item) => item.category).join(","),
    apiLevels: [appInfo.geApiLevel],
  });
  if (!deviceList.length) {
    throw new Error(`可用真机列表为空（appType=${appInfo.appType} testCategories=${JSON.stringify(settings.testCategories)} apiLevels=${appInfo.geApiLevel}）`);
  }
  // 云端按 apiLevels 返回的是"兼容"设备（API >= 包要求），会混入更高版本机型；
  // 优先选择与包同 API 版本的真机（openharmonySdk 精确匹配），无同版本时才放宽
  const apiLevel = Number(appInfo.geApiLevel) || 0;
  const exactApi = apiLevel
    ? deviceList.filter((device) => Number(device.openharmonySdk) === apiLevel)
    : [];
  if (exactApi.length) {
    onLog(`包 API${apiLevel}：优先选择同 API 版本真机（匹配 ${exactApi.length}/${deviceList.length} 台）`);
  } else {
    const availableApis = [...new Set(deviceList.map((device) => String(device.openharmonySdk)))].filter(Boolean).join(",");
    onLog(`[warn] 无 API${apiLevel} 同版本真机，已放宽到兼容设备（可用 API：${availableApis || "未知"}）`);
  }
  const ranked = rankBusinessDevices(exactApi.length ? exactApi : deviceList);
  const idleCount = ranked.filter((d) => (Number(d.idleDeviceCount) || 0) > 0).length;
  onLog(`真机候选 ${ranked.length} 台（空闲 ${idleCount} 台，可排队 ${ranked.length - idleCount} 台），空闲优先逐台尝试提交`);
  onLog(`候选顺序: ${ranked.slice(0, 5).map((d) => `${d.typeAlias || d.alias || d.type}(空闲${Number(d.idleDeviceCount) || 0}/可用${Number(d.usableNumber) || 0})`).join("、")}${ranked.length > 5 ? " ..." : ""}`);
  return ranked;
}

/**
 * 步骤 7：配额预检（非致命，失败仅告警）。
 * @returns {Promise<object|null>} 预检响应 data，失败返回 null
 */
async function predictQuota({ client, appInfo, devices, settings, onLog }) {
  try {
    const quota = await client.predictConfirm({
      testCategoryLists: settings.testCategories,
      deviceParamLists: [devices.map((d) => ({
        alias: d.alias,
        chargeMode: d.chargeMode ?? 0,
        deviceKind: d.deviceKind,
        emuiVersion: d.emuiVersion ?? "",
        freeLimitedTimes: d.freeLimitedTimes ?? false,
        groupId: d.groupId,
        harmonySdk: d.harmonySdk,
        hosVersion: d.hosVersion,
        openharmonySdk: d.openharmonySdk,
        resolution: d.resolution,
        rooted: d.rooted ?? 0,
        typeAlias: d.typeAlias,
      }))],
      appId: appInfo.id,
    });
    const data = quota?.data || {};
    onLog(`配额预检: 免费设备 ${data.freeDeviceNum}/${data.totalDeviceNum}，预计占用免费额度 ${data.predictFreeQuota} 分钟，余额充足=${data.amountEnough}`);
    return data;
  } catch (error) {
    onLog(`[warn] 配额预检失败（继续提交）: ${error.message}`);
    return null;
  }
}

/**
 * 步骤 7+8：按候选顺序逐台提交任务。
 * 每台提交前做配额预检：配额不足（amountEnough=false）属于账号级问题，
 * 立即中断不再尝试后续设备；单台提交失败（设备被占用等）则告警并尝试下一台。
 * @returns {Promise<object>} result.task 内容
 */
async function submitWithDeviceFallback({ client, appInfo, candidates, settings, taskName, taskNameLabel, appProfile, onLog }) {
  let lastError = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const device = candidates[index];
    const label = String(device.typeAlias || device.alias || device.type || "未知机型");
    const quota = await predictQuota({ client, appInfo, devices: [device], settings, onLog });
    if (quota && quota.amountEnough === false) {
      throw new Error(`配额不足，停止提交（剩余免费额度 ${quota.freeAmount ?? "?"} 分钟，余额 ${quota.validAmount ?? "?"}）；请在 AGC 控制台确认云测试配额后重试`);
    }
    try {
      onLog(`第 ${index + 1}/${candidates.length} 台尝试提交: ${label}（空闲 ${Number(device.idleDeviceCount) || 0}，等待 ${Number(device.waitTime) || 0} 分钟）`);
      return await submitCloudTask({ client, appInfo, devices: [device], settings, taskName, taskNameLabel, appProfile, onLog });
    } catch (error) {
      lastError = error;
      onLog(`[warn] ${label} 提交失败: ${error.message}`);
      if (index < candidates.length - 1) {
        // 连续快速提交会触发 "operation is too frequent"，间隔几秒再试下一台
        await delay(5_000, undefined, { signal }).catch(() => {});
        onLog("尝试下一台候选真机...");
      }
    }
  }
  throw new Error(`全部 ${candidates.length} 台候选真机提交均失败，最后一次错误: ${lastError?.message || lastError}`);
}

/** 单台设备转 task/submit 的 deviceParam 结构（字段与控制台抓包一致）。 */
function deviceParamForSubmit(device) {
  return {
    groupId: device.groupId,
    propertySwitch: 1,
    deviceType: device.type,
    deviceKind: device.deviceKind,
    resolution: device.resolution,
    emuiVersion: device.emuiVersion ?? "",
    hosVersion: device.hosVersion,
    harmonySdk: device.harmonySdk,
    chargeMode: device.chargeMode ?? 0,
    freeLimitedTimes: device.freeLimitedTimes ?? false,
    rooted: device.rooted ?? 0,
    typeAlias: device.typeAlias,
    openharmonySdk: device.openharmonySdk,
    alias: device.alias,
    openharmonyVersion: device.openharmonyVersion,
  };
}

/**
 * 步骤 8：组装并提交云测试任务。
 * @returns {Promise<object>} result.task 内容（含 taskGroupId 与完整 submitPayload）
 */
async function submitCloudTask({ client, appInfo, devices, settings, taskName, taskNameLabel, appProfile, onLog }) {
  // 任务名默认为 工程名_时间戳（批次内工程名=用例名 CaseXXXX，独立运行为工程目录名）
  const finalTaskName = String(taskName
    || `${taskNameLabel || appInfo.appName || appProfile?.bundleName || "app"}_${timestampName()}`).slice(0, 100);
  // 每个 testCategory 对应 deviceParamLists 的一个内层数组（与控制台提交结构一致）
  const submitPayload = {
    category: 1,
    thirdClass: settings.appClass,
    taskName: finalTaskName,
    testCategoryLists: settings.testCategories,
    taskType: settings.taskType,
    testItem: settings.testItem,
    deviceParamLists: settings.testCategories.map(() => devices.map(deviceParamForSubmit)),
    appId: appInfo.id,
    timeSpan: "0",
    packageRank: true,
    apiLevels: [appInfo.geApiLevel],
    agcOpenHarmonyTask: true,
    appType: appInfo.appType,
  };
  const taskGroupId = await client.submitTask(submitPayload);
  const timeSpanSummary = settings.testCategories.map((c) => `类别${c.category}×${c.timeSpan}分钟`).join("、");
  onLog(`任务已提交: taskGroupId=${taskGroupId}（${finalTaskName}，${devices.length} 台真机，${timeSpanSummary}）`);
  return {
    taskGroupId,
    taskName: finalTaskName,
    taskType: settings.taskType,
    testCategories: settings.testCategories,
    devices: devices.map((d) => ({ type: d.type, alias: d.alias, typeAlias: d.typeAlias, hosVersion: d.hosVersion, groupId: d.groupId })),
    submitPayload,
    submittedAt: new Date().toISOString(),
  };
}

/**
 * 步骤 9：轮询任务组状态直到最终态（3 已完成 / 4 已结束）。
 * @param {function} onUpdate — 每次状态变化时回调（taskGroup, polls），用于外部落盘
 * @returns {Promise<{taskGroup: object|null, finished: boolean}>} finished=false 表示超时
 */
async function pollTaskGroup({ client, taskGroupId, settings, signal, onLog, onUpdate }) {
  const deadline = Date.now() + settings.taskTimeoutSec * 1000;
  let misses = 0;
  let lastLabel = "";
  let taskGroup = null;
  let polls = 0;
  while (Date.now() < deadline) {
    throwIfInterrupted(signal);
    const groups = await client.listTaskGroups();
    const current = groups.find((g) => String(g.id) === String(taskGroupId));
    if (!current) {
      misses += 1;
      if (misses >= 5) throw new Error(`连续 ${misses} 次未在任务组列表中找到 ${taskGroupId}`);
    } else {
      misses = 0;
      taskGroup = current;
      polls += 1;
      const label = `status=${current.status}(${TASKGROUP_STATUS_LABELS[current.status] || "未知"}) resultStatus=${current.resultStatus} 进度 ${current.processedTestTaskCount ?? 0}/${current.taskCount ?? "?"}`;
      if (label !== lastLabel) {
        onLog(`任务状态: ${label}`);
        lastLabel = label;
      }
      onUpdate?.(current, polls);
      // 终态（status 3/4/5/6）或 resultStatus 已出结果（非零）即视为完成
      if (TASKGROUP_FINAL_STATUSES.has(Number(current.status)) || Number(current.resultStatus) > 0) {
        return { taskGroup: current, finished: true };
      }
    }
    try {
      await delay(settings.pollIntervalSec * 1000, undefined, { signal });
    } catch {
      throwIfInterrupted(signal);
      throw new Error("任务状态轮询等待被中断");
    }
  }
  return { taskGroup, finished: false };
}

// ============================================================
// 结果汇总与主流程
// ============================================================

/** 根据任务组终态推导本流程的最终状态。仅在轮询到终态后调用。
 * 口径：status 3/4/5/6 或 resultStatus 已出结果（非零）均视为完成。 */
function resolveFinalStatus(taskGroup) {
  const finalStatus = Number(taskGroup?.status);
  const hasResult = Number(taskGroup?.resultStatus) > 0;
  if (TASKGROUP_FINAL_STATUSES.has(finalStatus) || hasResult) {
    return { status: "completed", error: "" };
  }
  return {
    status: "failed",
    error: `任务组最终状态=${finalStatus}（resultStatus=${taskGroup?.resultStatus}）`,
  };
}

/** 任务终态后拉取 AGC 报告接口并生成 HTML 结果页（失败不影响主结果）。 */
async function generateHtmlReportFor(client, result, log) {
  const taskGroupId = result.task?.taskGroupId || result.taskGroupId || result.polling?.taskGroup?.id || "";
  try {
    if (!taskGroupId) throw new Error("缺少 taskGroupId");
    const { fetchTaskReport, writeCloudTestHtmlReport, summarizeTaskReport } = await import("./cloudtest-report.mjs");
    const category = result.task?.testCategories?.[0]?.category
      || result.polling?.taskGroup?.categoryList?.[0]
      || 24;
    const report = await fetchTaskReport(client, { taskGroupId, category });
    const htmlPath = await writeCloudTestHtmlReport({ result, report, outDir: result.outputDir });
    // 结构化摘要随 result.json 持久化，供批次报表与跨批次合并在数据层汇总
    result.report = {
      htmlPath,
      fetchedAt: new Date().toISOString(),
      summary: summarizeTaskReport(report),
      ...(report.errors?.length ? { dataErrors: report.errors } : {}),
    };
    return htmlPath;
  } catch (error) {
    result.report = { htmlPath: "", fetchedAt: new Date().toISOString(), error: error.message };
    log?.(`[warn] 云测试报告页生成失败: ${error.message}`);
    return "";
  }
}

/** 输出控制台结果摘要。 */
function printCloudTestSummary({ taskGroup, task, startedAt, resultPath, reportPath = "", onLog }) {
  const finalStatus = Number(taskGroup?.status);
  const elapsedSec = Math.round((Date.now() - startedAt.getTime()) / 1000);
  onLog("===== 云测试结果 =====");
  onLog(`任务组: ${task.taskGroupId}（${task.taskName}）`);
  onLog(`状态: ${TASKGROUP_STATUS_LABELS[finalStatus] || finalStatus}（status=${finalStatus} resultStatus=${taskGroup?.resultStatus}）`);
  onLog(`进度: ${taskGroup?.processedTestTaskCount ?? 0}/${taskGroup?.taskCount ?? "?"}；总耗时 ${Math.round(elapsedSec / 60)} 分钟`);
  onLog(`控制台: https://developer.huawei.com/consumer/cn/service/josp/agc/index.html`);
  onLog(`结果文件: ${resultPath}`);
  if (reportPath) onLog(`结果页面: ${reportPath}`);
}

/**
 * 续查已提交的云测试任务：不构建、不提交，仅轮询任务组状态直到终态。
 * 适用于轮询因 cookie 过期中断后，换新 cookie 查看既有任务结果的场景。
 */
export async function pollExistingTask({ config, taskGroupId, signal, onLog }) {
  const log = onLog || ((message) => console.log(message));
  const settings = loadCloudTestConfig(config);
  const client = new CloudTestClient(settings);
  const startedAt = new Date();
  const outDir = path.join(config.execution.outputRoot, "cloudtest", `poll_${timestampName(startedAt)}_${String(taskGroupId).slice(-8)}`);
  await fsp.mkdir(outDir, { recursive: true });
  const resultPath = path.join(outDir, "cloudtest-result.json");
  const result = {
    schemaVersion: "cloudtest-run-v1",
    status: "running",
    resumedPollOnly: true,
    taskGroupId: String(taskGroupId),
    outputDir: outDir,
    startedAt: startedAt.toISOString(),
    error: "",
  };
  const persist = () => atomicWriteJson(resultPath, result).catch(() => {});
  await persist();
  log(`续查任务组 ${taskGroupId}（超时 ${settings.taskTimeoutSec} 秒，每 ${settings.pollIntervalSec} 秒查询一次）`);
  try {
    const polling = await pollTaskGroup({
      client,
      taskGroupId: String(taskGroupId),
      settings,
      signal,
      onLog: log,
      onUpdate: (taskGroup, polls) => {
        result.polling = { taskGroup, polls, lastPolledAt: new Date().toISOString() };
        persist();
      },
    });
    throwIfInterrupted(signal);
    if (!polling.finished) {
      result.status = "timed_out";
      result.error = `等待云测试完成超时（${settings.taskTimeoutSec} 秒），任务组 ${taskGroupId} 仍未结束`;
    } else {
      const final = resolveFinalStatus(polling.taskGroup);
      result.status = final.status;
      result.error = final.error;
      const reportPath = await generateHtmlReportFor(client, result, log);
      printCloudTestSummary({
        taskGroup: polling.taskGroup,
        task: { taskGroupId: String(taskGroupId), taskName: polling.taskGroup?.taskGroupName || "" },
        startedAt,
        resultPath,
        reportPath,
        onLog: log,
      });
    }
    await persist();
    return result;
  } catch (error) {
    const interrupted = error.code === "AUTORUN_INTERRUPTED" || signal?.aborted;
    result.status = interrupted ? "interrupted" : "failed";
    result.error = error.message;
    await persist();
    throw error;
  } finally {
    result.finishedAt = new Date().toISOString();
    result.elapsedSec = Math.round((Date.now() - startedAt.getTime()) / 1000);
    await persist();
  }
}

/**
 * 提交阶段（步骤 1-8）：构建/取包 → 上传 → 解析 → 选机 → 提交任务。
 * 主批次流程中多个用例的提交阶段需要串行执行（避免提交频率限制），
 * 轮询阶段可并行，因此与 finishCloudTestPolling 拆开。
 * @returns {Promise<{client: CloudTestClient, settings: object, result: object, resultPath: string, startedAt: Date}>}
 * 失败时抛出错误并在 error.cloudResult 携带已落盘的部分结果。
 */
export async function submitCloudTestForProject({
  config,
  settings: providedSettings,
  projectDir = "",
  appPath = "",
  caseName = "",
  taskName = "",
  taskNameLabel = "",
  outDir: providedOutDir = "",
  signal,
  onLog,
}) {
  const log = onLog || ((message) => console.log(message));
  const settings = providedSettings || loadCloudTestConfig(config);
  const startedAt = new Date();
  const outDir = providedOutDir
    || path.join(config.execution.outputRoot, "cloudtest", `${timestampName(startedAt)}_${randomUUID().slice(0, 8)}`);
  await fsp.mkdir(outDir, { recursive: true });
  const resultPath = path.join(outDir, "cloudtest-result.json");
  const buildConsolePath = path.join(outDir, "build-console.log");

  const result = {
    schemaVersion: "cloudtest-run-v1",
    status: "running",
    case: caseName,
    projectDir,
    outputDir: outDir,
    startedAt: startedAt.toISOString(),
    error: "",
  };
  const persist = () => atomicWriteJson(resultPath, result).catch(() => {});
  await persist();

  try {
    const client = new CloudTestClient(settings);
    // py 同款流程：先 refresh 轮换登录态（新 auth 在 Set-Cookie，csrfToken 在 body）
    const expireAt = await client.refreshAuth();
    log(`登录态已 refresh 轮换（token 过期时间 ${new Date(client.authExpireTimeMs()).toISOString()}，仅本次运行内生效）`);
    void expireAt;

    // 步骤 1+2：解析待测包（读工程信息、必要时构建签名 .app）
    const prepared = await prepareAppArtifact({
      projectDir,
      appPath,
      settings,
      outDir,
      consolePath: buildConsolePath,
      signal,
      onLog: log,
    });
    result.app = { ...prepared.app };
    if (prepared.build) result.build = prepared.build;
    await persist();

    // 步骤 3：计算包摘要
    const digest = await computeAppDigest(prepared.appPath);
    result.app = {
      ...result.app,
      fileName: digest.fileName,
      path: prepared.appPath,
      fileSize: digest.fileSize,
      sha256: digest.sha256,
    };
    await persist();

    // 步骤 4：查询历史已上传包（暂不删除）；用替换后的有效 bundleName 比对
    const existing = await queryExistingPackages({
      client,
      bundleName: prepared.app?.bundleName || prepared.appProfile?.bundleName || "",
      onLog: log,
    });

    // 步骤 5：上传并等待云端解析
    const { upload, appInfo } = await uploadAndAnalyzeApp({
      client,
      digest,
      existingCount: existing.count,
      settings,
      signal,
      onLog: log,
    });
    result.upload = upload;
    await persist();
    warnPackageMismatch({ appInfo, bundleName: prepared.app?.bundleName || "", onLog: log });

    // 步骤 6：查询真机列表并按空闲程度排序（不依赖本地机型配置）
    const candidates = await selectCloudDevices({ client, appInfo, settings, onLog: log });

    // 步骤 7+8：配额预检 + 按候选顺序逐台尝试提交
    const task = await submitWithDeviceFallback({
      client,
      appInfo,
      candidates,
      settings,
      taskName,
      taskNameLabel,
      appProfile: prepared.appProfile,
      onLog: log,
    });
    result.task = task;
    await persist();
    return { client, settings, result, resultPath, startedAt };
  } catch (error) {
    const interrupted = error.code === "AUTORUN_INTERRUPTED" || signal?.aborted;
    result.status = interrupted ? "interrupted" : "failed";
    result.error = error.message;
    result.finishedAt = new Date().toISOString();
    await persist();
    error.cloudResult = result;
    throw error;
  }
}

/**
 * 轮询阶段（步骤 9）：等待任务组终态并汇总结果。可与其它任务的轮询并行。
 * @returns {Promise<object>} 最终 result（status: completed/failed/timed_out/interrupted）
 */
export async function finishCloudTestPolling({ client, settings, result, resultPath, startedAt, signal, onLog }) {
  const log = onLog || ((message) => console.log(message));
  const persist = () => atomicWriteJson(resultPath, result).catch(() => {});
  const task = result.task;
  try {
    // 轮询耗时可能超过 token 寿命，401 时客户端会自动刷新 cookie
    const polling = await pollTaskGroup({
      client,
      taskGroupId: task.taskGroupId,
      settings,
      signal,
      onLog: log,
      onUpdate: (taskGroup, polls) => {
        result.polling = { taskGroup, polls, lastPolledAt: new Date().toISOString() };
        persist();
      },
    });
    throwIfInterrupted(signal);

    if (!polling.finished) {
      result.status = "timed_out";
      result.error = `等待云测试完成超时（${settings.taskTimeoutSec} 秒），任务组 ${task.taskGroupId} 仍未结束；可稍后在 AGC 控制台查看`;
    } else {
      const final = resolveFinalStatus(polling.taskGroup);
      result.status = final.status;
      result.error = final.error;
      const reportPath = await generateHtmlReportFor(client, result, log);
      printCloudTestSummary({ taskGroup: polling.taskGroup, task, startedAt, resultPath, reportPath, onLog: log });
    }
    await persist();
    return result;
  } catch (error) {
    const interrupted = error.code === "AUTORUN_INTERRUPTED" || signal?.aborted;
    result.status = interrupted ? "interrupted" : "failed";
    result.error = error.message;
    await persist();
    error.cloudResult = result;
    throw error;
  } finally {
    if (!result.finishedAt) {
      result.finishedAt = new Date().toISOString();
      result.elapsedSec = Math.round((Date.now() - new Date(result.startedAt).getTime()) / 1000);
      await persist();
    }
  }
}

/**
 * 云测试主流程（独立指令用）：提交阶段 + 轮询阶段串行完成。
 * @param {object} options
 * @param {object} options.config — autorun 配置
 * @param {string} [options.projectDir] — HarmonyOS 工程根目录（--app 模式可空）
 * @param {string} [options.appPath] — 直接指定 .app 时跳过构建
 * @param {string} [options.caseName] — 用例名（仅用于报告）
 * @param {string} [options.taskName] — 任务名覆盖
 * @param {AbortSignal} [options.signal]
 * @param {function} [options.onLog]
 * @returns {Promise<object>} 云测试结果（同时写入 outDir/cloudtest-result.json）
 */
export async function runCloudTest({ config, projectDir = "", appPath = "", caseName = "", taskName = "", taskNameLabel = "", outDir = "", signal, onLog }) {
  const { client, settings, result, resultPath, startedAt } = await submitCloudTestForProject({
    config,
    projectDir,
    appPath,
    caseName,
    taskName,
    // 独立运行时工程名取工程目录名
    taskNameLabel: taskNameLabel || (projectDir ? path.basename(path.resolve(projectDir)) : ""),
    outDir,
    signal,
    onLog,
  });
  return finishCloudTestPolling({ client, settings, result, resultPath, startedAt, signal, onLog });
}

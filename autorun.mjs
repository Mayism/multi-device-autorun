#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { OpenCodeClient } from "./src/lib/opencode-client.mjs";
import { runMonitoredSession } from "./src/lib/session-monitor.mjs";
import { copyProject } from "./src/lib/sandbox-copy.mjs";
import { ConsoleReporter } from "./src/lib/console-reporter.mjs";
import { addTokenUsage, aggregateSessionMessages, emptyTokenUsage } from "./src/lib/token-usage.mjs";
import { addCompileUsage, collectCompileAttempts, emptyCompileUsage } from "./src/lib/compile-usage.mjs";
import { loadOhosTestConfig, runOhosTest } from "./src/lib/ohostest-orchestrator.mjs";
import { writeBatchReport } from "./src/lib/batch-report.mjs";
import { OPENCODE_SOURCE_MODES, resolveOpenCodeSource } from "./src/lib/opencode-installation.mjs";

const AUTORUN_ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_ROOT = path.join(AUTORUN_ROOT, "output");
const SKILL_REQUEST_TIMEOUT_SEC = 30;
const SKILL_READY_TIMEOUT_SEC = 180;
const SKILL_RETRY_INTERVAL_MS = 2_000;
const SESSION_CREATE_TIMEOUT_SEC = 120;
let activeReporter = null;

const AGENT_SANDBOX_POLICY = `# 工作目录隔离要求（强制）

- 只允许访问当前工程工作目录及其子目录；下文明确给出的设备租约工具和租约文件路径除外，且只能用于获取/释放设备租约。
- 不得枚举、读取或尝试访问工作目录外的用例、补丁、元数据、运行结果或评测文件。
- 任务所需信息仅以本提示词和当前工程内容为准。

# 设备验证与测试阶段边界（强制）

- 你的职责是修改当前工程的业务源代码；可执行静态检查、依赖安装、编译验证。仅在无法仅靠代码和编译确认修复效果时，才可启动模拟器/真机并使用 hdc 做必要的运行时验证。
- 所有模拟器、hdc、HAP 安装或 UI 自动化命令都必须在同一次“设备租约”命令内完成；该命令会与其他 Agent 及 ohostest 串行化设备访问。
- 若启动了任何模拟器实例，必须在该设备租约命令结束前停止本次启动的同名实例，并确认不再保留由本次会话启动的设备进程或安装/测试任务。
- 不得执行 ohostest；正式设备测试由 Autorun 在 Agent 会话结束后统一串行编排。完成必要验证和清理后应结束任务。`;

function agentDeviceLeasePolicy(caseName, deviceLeasePath) {
  const helperPath = path.join(AUTORUN_ROOT, "src", "lib", "device-lease.mjs");
  return `# 设备租约调用方式（强制）

- 本用例的设备租约路径：\`${deviceLeasePath}\`。
- 设备验证必须使用以下形式，\`--\` 后放入一条覆盖“启动 → 验证 → 停止”的完整命令；不得拆成多次直接调用：
  \`node "${helperPath}" run --lock "${deviceLeasePath}" --owner "agent:${caseName}" -- <命令> [参数]\`
- 租约会在命令退出时自动释放。若设备验证不必要，则不要获取租约。`;
}

function parseArgs(argv) {
  const result = {
    configPath: "./config/autorun.config.json",
    checkOnly: false,
    retryBatchId: "",
    retryCaseName: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--config" || value === "-c") {
      if (!argv[index + 1]) throw new Error(`${value} 需要配置文件路径`);
      result.configPath = argv[++index];
    } else if (value === "--check") {
      result.checkOnly = true;
    } else if (value === "--retry") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("--retry 需要历史批次 ID");
      result.retryBatchId = argv[++index];
    } else if (value === "--case") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("--case 需要用例名称");
      result.retryCaseName = argv[++index];
    } else if (value === "--help" || value === "-h") {
      console.log([
        "用法:",
        "  node autorun.mjs [--config config/autorun.config.json] [--check]",
        "  node autorun.mjs --retry <batchId> [--case <caseName>] [--config config/autorun.config.json]",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${value}`);
    }
  }
  if (result.retryCaseName && !result.retryBatchId) throw new Error("--case 只能和 --retry 一起使用");
  if (result.checkOnly && result.retryBatchId) throw new Error("--check 不能和 --retry 一起使用");
  return result;
}

function resolveFrom(baseDir, value) {
  return value ? path.resolve(baseDir, value) : "";
}

async function loadAutorunConfig(configPath = "./config/autorun.config.json") {
  const absolutePath = path.resolve(configPath);
  if (path.extname(absolutePath).toLowerCase() !== ".json") {
    throw new Error(`Autorun 配置必须为 JSON 文件: ${absolutePath}`);
  }
  let config;
  try {
    config = JSON.parse(await fs.readFile(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON: ${absolutePath}: ${error.message}`);
  }
  if (!config || typeof config !== "object") {
    throw new Error(`配置文件必须为 JSON 对象: ${absolutePath}`);
  }
  const baseDir = path.dirname(absolutePath);
  const normalized = structuredClone(config);
  normalized.__configPath = absolutePath;
  normalized.__baseDir = baseDir;
  normalized.server ||= {};
  normalized.execution ||= {};
  const source = normalized.server.opencodeSource;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("缺少 server.opencodeSource 配置");
  }
  normalized.server.opencodeSource = {
    mode: String(source.mode || "").trim(),
    root: resolveFrom(baseDir, source.root || ""),
  };
  normalized.server.loadAgents = Array.isArray(normalized.server.loadAgents)
    ? normalized.server.loadAgents.map((a) => String(a).trim()).filter(Boolean)
    : [];
  normalized.execution.casesRoot = resolveFrom(baseDir, normalized.execution.casesRoot || "./cases");
  normalized.execution.outputRoot = resolveFrom(
    baseDir,
    normalized.execution.outputRoot || OUTPUT_ROOT,
  );
  normalized.server.runtimeRoot = resolveFrom(
    baseDir,
    normalized.server.runtimeRoot || path.join(normalized.execution.outputRoot, "_runtime", "opencode"),
  );
  return normalized;
}

// 健康检查：loadAgents 非空时，校验 execution.agent 必须在其列表中。
// 校验不通过直接抛错中断，提示用户修改配置。
function checkLoadAgents(config) {
  const loadAgents = Array.isArray(config?.server?.loadAgents) ? config.server.loadAgents : [];
  if (!loadAgents.length) return;
  const agent = String(config?.execution?.agent || "").trim();
  if (agent && !loadAgents.includes(agent)) {
    throw new Error(
      `execution.agent "${agent}" 不在 server.loadAgents [${loadAgents.join(", ")}] 中。` +
      `请修改 config/autorun.config.json：将 "${agent}" 加入 server.loadAgents，或清空 loadAgents 数组以加载全部 Agent。`,
    );
  }
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function requestGracefulServerStop(child) {
  if (child.connected && typeof child.send === "function") {
    try {
      const delivered = await new Promise((resolve) => {
        child.send({ type: "autorun:shutdown" }, (error) => resolve(!error));
      });
      if (delivered) return;
    } catch {
      // IPC 可能在状态检查后关闭，继续尝试发送普通终止信号。
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // 强制结束阶段会处理已失效或拒绝信号的进程。
  }
}

async function forceStopServerProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("close", resolve);
      killer.once("error", resolve);
    });
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // 进程可能在强制信号发出前已经退出。
  }
}

async function stopServerProcessTree(child, { gracefulTimeoutMs = 5000 } = {}) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
    return { forced: false };
  }
  await requestGracefulServerStop(child);
  if (await waitForChildExit(child, gracefulTimeoutMs)) {
    return { forced: false };
  }
  await forceStopServerProcessTree(child);
  await waitForChildExit(child, 5000);
  return { forced: true };
}

function canConnectToServer(serverUrl, timeoutMs = 500) {
  let target;
  try {
    target = new URL(serverUrl);
  } catch {
    return Promise.resolve(false);
  }
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  return new Promise((resolve) => {
    const socket = createConnection({ host: target.hostname, port });
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitForServerPortReleased(serverUrl, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await canConnectToServer(serverUrl)) return true;
    await delay(200);
  }
  return !await canConnectToServer(serverUrl);
}

function canBindServerUrl(serverUrl) {
  let target;
  try {
    target = new URL(serverUrl);
  } catch {
    return Promise.resolve(false);
  }
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  return new Promise((resolve) => {
    const probe = createServer();
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      resolve(available);
    };
    probe.once("error", () => finish(false));
    probe.listen({ host: target.hostname, port, exclusive: true }, () => {
      probe.close(() => finish(true));
    });
  });
}

async function selectAvailableServerUrl(configuredUrl, maxAttempts = 20) {
  const target = new URL(configuredUrl);
  const configuredPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = configuredPort + offset;
    if (port > 65535) break;
    target.port = String(port);
    if (await canBindServerUrl(target.toString())) return target.toString().replace(/\/$/, "");
  }
  throw new Error(`OpenCode Server 端口不可用，已尝试 ${configuredPort}-${Math.min(65535, configuredPort + maxAttempts - 1)}`);
}

async function waitForServerConfig(client, {
  timeoutSec = 120,
  retryIntervalMs = 1000,
  signal,
} = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastError = null;
  while (Date.now() < deadline) {
    throwIfInterrupted(signal);
    const remainingSec = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    const attemptTimeoutSec = Math.min(60, remainingSec);
    try {
      return await client.getConfig(attemptTimeoutSec, signal);
    } catch (error) {
      if (signal?.aborted) throw interruptionError(signal.reason);
      lastError = error;
    }
    if (Date.now() < deadline) await delay(Math.min(retryIntervalMs, deadline - Date.now()));
  }
  const detail = lastError?.message ? `；最后一次错误: ${lastError.message}` : "";
  throw new Error(`OpenCode Server 配置加载超时（${timeoutSec} 秒）${detail}`);
}

async function waitForSkills(client, directory, {
  timeoutSec = SKILL_READY_TIMEOUT_SEC,
  requestTimeoutSec = SKILL_REQUEST_TIMEOUT_SEC,
  retryIntervalMs = SKILL_RETRY_INTERVAL_MS,
  signal,
} = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastError = null;
  let attempts = 0;

  while (Date.now() < deadline) {
    throwIfInterrupted(signal);
    attempts += 1;
    const remainingSec = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    try {
      return await client.listSkills(directory, Math.min(requestTimeoutSec, remainingSec), signal);
    } catch (error) {
      if (signal?.aborted) throw interruptionError(signal.reason);
      lastError = error;
      const status = Number(error?.status) || 0;
      if (status && status !== 408 && status !== 429 && status < 500) throw error;
    }

    if (Date.now() < deadline) {
      const waitedSec = Math.min(timeoutSec, Math.round((timeoutSec * 1000 - (deadline - Date.now())) / 1000));
      console.warn(`[server] Skill 列表加载未完成，${retryIntervalMs / 1000} 秒后重试（第 ${attempts} 次，已等待 ${waitedSec}/${timeoutSec} 秒）`);
      await delay(Math.min(retryIntervalMs, deadline - Date.now()));
    }
  }

  const detail = lastError?.message ? `；最后一次错误: ${lastError.message}` : "";
  throw new Error(`OpenCode Server Skill 加载超时（${timeoutSec} 秒）${detail}`, { cause: lastError });
}

async function ensureOpenCodeServer(config, { log = console.log, signal } = {}) {
  if (signal?.aborted) throw interruptionError(signal.reason);
  const source = await resolveOpenCodeSource(config.server.opencodeSource);
  log(`[server] OpenCode 来源模式: ${source.mode}`);
  const configuredServerUrl = String(config.server.url || "").trim();
  if (!configuredServerUrl) throw new Error("未配置 server.url");
  let serverUrl = configuredServerUrl;
  let client = new OpenCodeClient(serverUrl);
  if (await client.health()) {
    log("[server] 健康检查通过，正在等待 Agent、Plugin、Skill 和 Provider 配置加载");
    const serverConfig = await waitForServerConfig(client, { signal });
    log(`[server] 复用已运行的 OpenCode Server: ${serverUrl}`);
    return { client, serverConfig, owned: false, child: null, logPath: "" };
  }

  serverUrl = await selectAvailableServerUrl(configuredServerUrl);
  if (serverUrl !== configuredServerUrl.replace(/\/$/, "")) {
    log(`[server] 配置端口不可用，自动改用: ${serverUrl}`);
    client = new OpenCodeClient(serverUrl);
  }

  const serveScript = fileURLToPath(new URL("./src/run-opencode-serve.mjs", import.meta.url));
  if (!await exists(serveScript)) throw new Error(`启动脚本不存在: ${serveScript}`);
  const runtimeRoot = config.server.runtimeRoot;
  const port = new URL(serverUrl).port || "61417";
  const runId = `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-autorun-serve`;
  const logDir = path.join(runtimeRoot, "logs", "runs", runId);
  const logPath = path.join(logDir, "opencode-server.log");
  await fs.mkdir(logDir, { recursive: true });
  const logFile = await fs.open(logPath, "a");
  const args = [
    serveScript,
    "--source", source.resourcesDir,
    "--runtime-root", runtimeRoot,
    "--workspace", AUTORUN_ROOT,
    "--port", port,
  ];
  if (config.server.devecoHome) args.push("--deveco-home", config.server.devecoHome);
  if (Array.isArray(config.server.loadAgents) && config.server.loadAgents.length) {
    args.push("--load-agents", config.server.loadAgents.join(","));
  }

  if (source.mode === OPENCODE_SOURCE_MODES.HARMONY_BOT) {
    log(`[server] 使用 HarmonyBot 扩展 ${source.installation.version}: ${source.installation.extensionDir}`);
  } else {
    log(`[server] 使用 Software Engineering 资源: ${source.root}`);
  }
  log(`[server] OpenCode 资源目录: ${source.resourcesDir}`);
  log(`[server] OpenCode 运行数据: ${runtimeRoot}`);
  log(`[server] 自动调用 run-opencode-serve.mjs: ${process.execPath} ${args.slice(0, 1).concat(args.slice(1)).join(" ")}`);
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: config.__baseDir,
      stdio: ["ignore", logFile.fd, logFile.fd, "ipc"],
      windowsHide: true,
    });
  } finally {
    await logFile.close();
  }

  let spawnError = null;
  child.once("error", (error) => { spawnError = error; });
  const healthDeadline = Date.now() + 120_000;
  let healthy = false;
  while (Date.now() < healthDeadline) {
    if (signal?.aborted) {
      await stopServerProcessTree(child);
      throw interruptionError(signal.reason);
    }
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) break;
    if (await client.health()) {
      healthy = true;
      break;
    }
    await delay(1000);
  }

  if (!healthy) {
    await stopServerProcessTree(child);
    if (child.exitCode !== null) {
      throw new Error(`OpenCode Server 启动后提前退出（code=${child.exitCode}），日志: ${logPath}`);
    }
    throw new Error(`OpenCode Server 健康检查超时，日志: ${logPath}`);
  }

  log("[server] 健康检查通过，正在等待 Agent、Plugin、Skill 和 Provider 配置加载");
  let serverConfig;
  try {
    serverConfig = await waitForServerConfig(client, { signal });
  } catch (error) {
    await stopServerProcessTree(child);
    throw new Error(`${error.message}；日志: ${logPath}`, { cause: error });
  }
  child.unref();
  log(`[server] OpenCode Server 已就绪: ${serverUrl}`);
  return { client, serverConfig, owned: true, child, logPath, serverUrl };
}

async function stopOwnedServer(server, { log = console.log } = {}) {
  if (!server?.owned || !server.child) return;
  if (server.child.exitCode === null && server.child.signalCode === null) {
    log("[server] 正在优雅关闭本次自动启动的 OpenCode Server");
    const { forced } = await stopServerProcessTree(server.child);
    if (forced) log("[server] OpenCode Server 未在 5 秒内退出，已强制结束进程树");
  }
  const released = await waitForServerPortReleased(server.serverUrl, 5000);
  if (released) {
    log(`[server] OpenCode Server 端口已释放: ${new URL(server.serverUrl).port}`);
  } else {
    console.warn(`[warn] OpenCode Server 已结束，但端口仍未释放: ${server.serverUrl}`);
  }
}

function batchId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const time = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${time}_${randomUUID().slice(0, 8)}`;
}

function safeName(value) {
  return String(value || "case").replace(/[^0-9A-Za-z._-]+/g, "_").slice(0, 120) || "case";
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

function interruptionError(reason = "Autorun 执行被中断") {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  error.code ||= "AUTORUN_INTERRUPTED";
  return error;
}

function throwIfInterrupted(signal) {
  if (signal?.aborted) throw interruptionError(signal.reason);
}

class BatchStateStore {
  constructor(filePath, state) {
    this.filePath = filePath;
    this.state = state;
    this.writeChain = Promise.resolve();
  }

  setBatch(values) {
    Object.assign(this.state, values, { updatedAt: new Date().toISOString() });
    return this.persist();
  }

  setCase(caseName, values) {
    Object.assign(this.state.cases[caseName], values, { updatedAt: new Date().toISOString() });
    return this.persist();
  }

  persist() {
    const snapshot = structuredClone(this.state);
    this.writeChain = this.writeChain.then(() => atomicWriteJson(this.filePath, snapshot));
    return this.writeChain;
  }
}

const FINISHED_CASE_STATUSES = new Set(["completed", "failed", "timed_out", "cancelled", "interrupted"]);

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function loadRetryPlan(outputRoot, batchId, requestedCaseName = "") {
  const normalizedBatchId = String(batchId || "").trim();
  const resolvedOutputRoot = path.resolve(outputRoot);
  const sourceBatchRoot = path.resolve(resolvedOutputRoot, normalizedBatchId);
  const relativeBatchPath = path.relative(resolvedOutputRoot, sourceBatchRoot);
  if (
    !normalizedBatchId
    || path.basename(normalizedBatchId) !== normalizedBatchId
    || !relativeBatchPath
    || path.isAbsolute(relativeBatchPath)
    || relativeBatchPath === ".."
    || relativeBatchPath.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`无效的重试批次 ID: ${batchId || "<empty>"}`);
  }

  const batch = await readJson(path.join(sourceBatchRoot, "batch.json"));
  const summary = await readJson(path.join(sourceBatchRoot, "summary.json"));
  if (!batch?.cases || typeof batch.cases !== "object") {
    throw new Error(`重试批次不存在或 batch.json 无效: ${sourceBatchRoot}`);
  }

  const summaryResults = new Map(
    (Array.isArray(summary?.results) ? summary.results : [])
      .filter((item) => item?.case)
      .map((item) => [String(item.case), item]),
  );
  const previousResults = new Map();
  for (const [caseName, caseState] of Object.entries(batch.cases)) {
    const resultPath = caseState?.resultPath || path.join(sourceBatchRoot, caseName, "result.json");
    const result = await readJson(resultPath);
    previousResults.set(caseName, result || summaryResults.get(caseName) || {
      case: caseName,
      status: caseState?.status || "failed",
      agentStatus: caseState?.agentStatus || "",
      error: caseState?.error || "",
      projectName: caseState?.projectName || "",
      projectDir: caseState?.projectDir || "",
      patchPath: caseState?.patchPath || "",
      resultPath,
    });
  }

  const caseNames = [...previousResults.keys()];
  let selectedCaseNames;
  if (requestedCaseName) {
    const requested = String(requestedCaseName).trim();
    const exact = caseNames.find((name) => name === requested);
    const insensitive = caseNames.filter((name) => name.toLowerCase() === requested.toLowerCase());
    const matched = exact || (insensitive.length === 1 ? insensitive[0] : "");
    if (!matched) {
      throw new Error(`批次 ${normalizedBatchId} 中不存在用例 ${requested}；可选用例: ${caseNames.join(", ")}`);
    }
    selectedCaseNames = [matched];
  } else {
    selectedCaseNames = caseNames.filter((caseName) => {
      const status = previousResults.get(caseName)?.status || batch.cases[caseName]?.status || "";
      return status !== "completed" && status !== "skipped";
    });
    if (!selectedCaseNames.length) {
      throw new Error(`批次 ${normalizedBatchId} 没有可重试的失败或中断用例`);
    }
  }

  return {
    sourceBatchId: normalizedBatchId,
    sourceBatchRoot,
    requestedCaseName: requestedCaseName ? selectedCaseNames[0] : "",
    selectedCaseNames,
    previousResults,
  };
}

function elapsedSeconds(startedAt, finishedAt) {
  const start = Date.parse(startedAt || "");
  const finish = Date.parse(finishedAt || "");
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return 0;
  return Math.max(0, Math.round((finish - start) / 1000));
}

async function recoverInterruptedRuns(outputRoot) {
  if (!await exists(outputRoot)) return [];
  const recovered = [];
  const entries = await fs.readdir(outputRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const batchRoot = path.join(outputRoot, entry.name);
    const batchPath = path.join(batchRoot, "batch.json");
    const batch = await readJson(batchPath);
    if (!batch || batch.status !== "running" || !batch.cases || typeof batch.cases !== "object") continue;

    const recoveredAt = new Date().toISOString();
    const results = [];
    for (const [caseName, current] of Object.entries(batch.cases)) {
      if (FINISHED_CASE_STATUSES.has(current.status)) {
        const existingResult = current.resultPath ? await readJson(current.resultPath) : null;
        results.push(existingResult || {
          case: caseName,
          status: current.status,
          error: current.error || "",
          startedAt: current.startedAt || "",
          finishedAt: current.finishedAt || recoveredAt,
          tokenUsage: current.tokenUsage || emptyTokenUsage(),
          agentCompile: current.agentCompile || emptyCompileUsage(),
        });
        continue;
      }

      const started = current.status !== "pending";
      const status = started ? "interrupted" : "cancelled";
      const error = started
        ? "上次 Autorun 进程在用例完成前退出"
        : "上次批次被中断，用例尚未开始执行";
      Object.assign(current, {
        status,
        stage: status,
        error,
        finishedAt: recoveredAt,
        updatedAt: recoveredAt,
        recoveredAt,
      });

      const existingResultPath = current.resultPath || (current.runDir ? path.join(current.runDir, "result.json") : "");
      const existingResult = existingResultPath ? await readJson(existingResultPath) : null;
      const result = {
        ...(existingResult || {}),
        case: caseName,
        status,
        sessionId: current.sessionId || "",
        childSessionIds: current.childSessionIds || [],
        error,
        startedAt: current.startedAt || "",
        finishedAt: recoveredAt,
        elapsedSec: elapsedSeconds(current.startedAt, recoveredAt),
        projectDir: current.projectDir || "",
        recoveredAt,
        tokenUsage: current.tokenUsage || emptyTokenUsage(),
        agentCompile: existingResult?.agentCompile || current.agentCompile || emptyCompileUsage(),
      };
      if (started && current.runDir) {
        const generateDir = path.join(current.runDir, "generate");
        const patchPath = path.join(current.runDir, "diff", "changes.patch");
        const resultPath = current.resultPath || path.join(current.runDir, "result.json");
        result.resultPath = resultPath;
        result.patchPath = await exists(patchPath) ? patchPath : "";
        result.logs = {
          ...(existingResult?.logs || {}),
          transcriptPath: await exists(path.join(generateDir, "agent-output.log")) ? path.join(generateDir, "agent-output.log") : "",
          messagesPath: await exists(path.join(generateDir, "all-messages.json")) ? path.join(generateDir, "all-messages.json") : "",
          ssePath: path.join(generateDir, "opencode-sse.jsonl"),
          pollingPath: path.join(generateDir, "opencode-polling.jsonl"),
          executionPath: path.join(current.runDir, "execution.jsonl"),
          consolePath: path.join(generateDir, "agent-console.log"),
          ohosTestConsolePath: existingResult?.ohosTest?.consolePath || existingResult?.logs?.ohosTestConsolePath || "",
        };
        current.resultPath = resultPath;
        await atomicWriteJson(resultPath, result);
        const statePath = path.join(current.runDir, "state.json");
        const caseState = await readJson(statePath) || { case: caseName };
        await atomicWriteJson(statePath, { ...caseState, ...current });
      }
      results.push(result);
    }

    const failed = results.filter((item) => item.status !== "completed").length;
    const tokenUsage = addTokenUsage(...results.map((item) => item.tokenUsage));
    const agentCompile = addCompileUsage(...results.map((item) => item.agentCompile));
    const summary = {
      batchId: batch.batchId || entry.name,
      status: "interrupted",
      finishedAt: recoveredAt,
      recoveredAt,
      total: results.length,
      completed: results.filter((item) => item.status === "completed").length,
      failed,
      tokenUsage,
      agentCompile,
      results,
    };
    Object.assign(batch, {
      status: "interrupted",
      finishedAt: recoveredAt,
      updatedAt: recoveredAt,
      recoveredAt,
      error: "检测到上次 Autorun 未正常完成，已收尾遗留用例状态",
    });
    try {
      summary.reports = await writeBatchReport({ batchRoot, summary });
    } catch (error) {
      summary.reportError = error.message;
      console.warn(`[warn] 批次报告生成失败: ${error.message}`);
    }
    await atomicWriteJson(path.join(batchRoot, "summary.json"), summary);
    await atomicWriteJson(batchPath, batch);
    recovered.push({ batchId: batch.batchId || entry.name, batchRoot });
  }
  return recovered;
}

async function discoverCases(casesRoot, { requireOhosTest = false } = {}) {
  if (!await exists(casesRoot)) throw new Error(`casesRoot 不存在: ${casesRoot}`);
  const entries = await fs.readdir(casesRoot, { withFileTypes: true });
  const runnable = [];
  const skipped = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const caseRoot = path.join(casesRoot, entry.name);
    const promptPath = path.join(caseRoot, "PROMPT.md");
    const issues = [];
    let projectName = "";
    let projectDir = "";
    const invalidProjectNames = [];
    for (const candidate of ["base", "task"]) {
      const candidateDir = path.join(caseRoot, candidate);
      try {
        const stat = await fs.stat(candidateDir);
        if (stat.isDirectory()) {
          if (!projectName) {
            projectName = candidate;
            projectDir = candidateDir;
          }
        } else {
          invalidProjectNames.push(`${candidate} 不是目录`);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") invalidProjectNames.push(`${candidate} 无法访问`);
      }
    }
    if (!projectName) {
      issues.push(invalidProjectNames.length
        ? invalidProjectNames.join("；")
        : "缺少 base/ 或 task/ 工程目录");
    }
    try {
      const prompt = await fs.readFile(promptPath, "utf8");
      if (!prompt.trim()) issues.push("PROMPT.md 为空");
    } catch {
      issues.push("缺少 PROMPT.md");
    }
    if (requireOhosTest) {
      const metadataPath = path.join(caseRoot, "metadata.json");
      let metadata;
      try {
        metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
      } catch {
        issues.push("缺少或无法解析 metadata.json");
      }
      if (metadata) {
        for (const field of ["base_project", "test_patch", "golden_patch"]) {
          if (!metadata[field]) issues.push(`metadata.json 缺少 ${field}`);
        }
        for (const field of ["test_patch", "golden_patch"]) {
          const relative = String(metadata[field] || "").trim();
          if (relative && !await exists(path.join(caseRoot, relative))) {
            issues.push(`缺少 ${relative}`);
          }
        }
        if (projectDir && metadata.base_project) {
          const configuredProject = path.resolve(caseRoot, String(metadata.base_project));
          if (configuredProject !== path.resolve(projectDir)) {
            issues.push(`metadata.base_project 必须指向实际工程 ${projectName}`);
          }
        }
      }
    }
    const item = { name: entry.name, caseRoot, projectName, projectDir, promptPath };
    if (issues.length) skipped.push({ ...item, skipReason: issues.join("；") });
    else runnable.push(item);
  }
  if (!runnable.length) {
    const details = skipped.map((item) => `${item.name}: ${item.skipReason}`).join("；");
    throw new Error(`未发现可执行用例${details ? `（${details}）` : ""}`);
  }
  return { runnable, skipped };
}

function runCommand(command, args, { cwd, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (code !== 0 && !allowFailure) {
        reject(new Error(`${command} ${args.join(" ")} 执行失败(${code}): ${result.stderr.toString("utf8") || result.stdout.toString("utf8")}`));
      } else {
        resolve(result);
      }
    });
  });
}

function compactPreview(value, maxLength = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function formatAgentProgress(data) {
  const tool = data.latestTool;
  const preview = compactPreview(data.latestPreview);
  const previewLabel = data.latestPreviewType === "text" ? "回复" : "分析";
  if (tool) {
    const statusLabels = {
      pending: "等待执行",
      running: "执行中",
      completed: "已完成",
      error: "执行失败",
    };
    const status = statusLabels[tool.status] || tool.status;
    const description = tool.description ? `：${tool.description}` : "";
    const keyOutput = preview ? `；${previewLabel}：“${preview}”` : "";
    return `工具 ${tool.name} ${status}${description}${keyOutput}`;
  }
  if (preview) return `${previewLabel}：“${preview}”`;
  if (data.finish && !["tool-calls", "unknown"].includes(data.finish)) return "模型响应已结束，正在确认会话状态";
  return data.hasMeaningfulOutput ? "等待模型下一步响应" : "等待模型首个有效响应";
}

function renderAgentTranscript(sessions) {
  const lines = [];
  for (const session of sessions) {
    lines.push(`===== SESSION ${session.sessionId} =====`);
    if (session.error) {
      lines.push(`[读取失败] ${session.error}`, "");
      continue;
    }
    for (const message of session.messages) {
      const info = message?.info || {};
      const role = String(info.role || message?.role || "unknown").toUpperCase();
      lines.push(`--- ${role} ${info.id || message?.id || ""} ---`);
      for (const part of Array.isArray(message?.parts) ? message.parts : []) {
        const type = String(part?.type || "unknown").toLowerCase();
        if ((type === "text" || type === "reasoning") && typeof part.text === "string") {
          lines.push(`[${type}]`, part.text);
        } else if (type === "tool") {
          const state = part.state || {};
          lines.push(`[tool:${part.tool || "unknown"}] status=${state.status || "unknown"}`);
          if (state.input !== undefined) lines.push(`[input] ${JSON.stringify(state.input, null, 2)}`);
          const output = state.output ?? state.metadata?.output;
          if (output !== undefined && output !== "") {
            lines.push(`[output] ${typeof output === "string" ? output : JSON.stringify(output, null, 2)}`);
          }
          if (state.error) lines.push(`[error] ${typeof state.error === "string" ? state.error : JSON.stringify(state.error, null, 2)}`);
        } else if (!new Set(["step-start", "step-finish"]).has(type)) {
          lines.push(`[${type}] ${JSON.stringify(part, null, 2)}`);
        }
      }
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

async function saveAgentLogs(client, sessionIds, generateDir) {
  const uniqueIds = [...new Set(sessionIds.filter(Boolean))];
  const sessions = [];
  for (const targetId of uniqueIds) {
    try {
      const messages = await client.listMessages(targetId, 0, 30);
      sessions.push({ sessionId: targetId, messages: Array.isArray(messages) ? messages : [] });
    } catch (error) {
      sessions.push({ sessionId: targetId, messages: [], error: error.message });
    }
  }

  const messagesPath = path.join(generateDir, "all-messages.json");
  const transcriptPath = path.join(generateDir, "agent-output.log");
  const compileAttemptsPath = path.join(generateDir, "compile-attempts.json");
  const tokenUsage = aggregateSessionMessages(sessions);
  const compileAttempts = collectCompileAttempts(sessions);
  const { items: _compileAttemptItems, ...agentCompile } = compileAttempts;
  await atomicWriteJson(messagesPath, sessions);
  await fs.writeFile(transcriptPath, renderAgentTranscript(sessions), "utf8");
  await atomicWriteJson(compileAttemptsPath, compileAttempts);
  return { messagesPath, transcriptPath, compileAttemptsPath, tokenUsage, agentCompile };
}

async function initializeGitBaseline(projectDir) {
  await runCommand("git", ["init"], { cwd: projectDir });
  await runCommand("git", ["config", "user.name", "autorun"], { cwd: projectDir });
  await runCommand("git", ["config", "user.email", "autorun@example.local"], { cwd: projectDir });
  const excludePath = path.join(projectDir, ".git", "info", "exclude");
  await fs.appendFile(excludePath, "\n.opencode/\nnode_modules/\nbuild/\n", "utf8");
  await runCommand("git", ["add", "-A", "--", "."], { cwd: projectDir });
  await runCommand("git", ["commit", "--allow-empty", "-m", "autorun project baseline"], { cwd: projectDir });
  const rev = await runCommand("git", ["rev-parse", "HEAD"], { cwd: projectDir });
  return rev.stdout.toString("utf8").trim();
}

async function generatePatch(projectDir, baseline, patchPath) {
  await runCommand("git", ["add", "-A", "--", "."], { cwd: projectDir });
  const diff = await runCommand("git", ["diff", "--binary", baseline], { cwd: projectDir, allowFailure: true });
  if (![0, 1].includes(diff.code)) {
    throw new Error(`生成 patch 失败: ${diff.stderr.toString("utf8")}`);
  }
  await fs.mkdir(path.dirname(patchPath), { recursive: true });
  await fs.writeFile(patchPath, diff.stdout);
}

async function appendCaseLog(logPath, level, message, data = {}) {
  const row = { timestamp: new Date().toISOString(), level, message, ...data };
  await fs.appendFile(logPath, `${JSON.stringify(row)}\n`, "utf8");
}

async function runCase({ caseInfo, batchRoot, client, model, execution, ohosTestEnabled, store, reporter, signal }) {
  const caseName = caseInfo.name;
  const deviceLeasePath = path.join(batchRoot, ".device-validation.lock");
  const caseRunDir = path.join(batchRoot, safeName(caseName));
  const originalDir = path.join(caseRunDir, "original");
  // 保留源用例的工程目录名（base 或 task），使输出工程与 metadata.base_project 一致。
  const projectDir = path.join(caseRunDir, caseInfo.projectName);
  const generateDir = path.join(caseRunDir, "generate");
  const patchPath = path.join(caseRunDir, "diff", "changes.patch");
  const resultPath = path.join(caseRunDir, "result.json");
  const statePath = path.join(caseRunDir, "state.json");
  const caseLogPath = path.join(caseRunDir, "execution.jsonl");
  const agentConsolePath = path.join(generateDir, "agent-console.log");
  const startedAt = new Date();
  let baseline = "";
  let sessionId = "";
  let latestTokenUsage = emptyTokenUsage();
  let lastPersistedTokenTotal = -1;
  let agentConsoleWriteChain = Promise.resolve();

  const writeAgentConsole = (kind, message) => {
    const line = `[${new Date().toISOString()}] [${kind}] ${String(message || "").trim()}\n`;
    agentConsoleWriteChain = agentConsoleWriteChain.then(() => fs.appendFile(agentConsolePath, line, "utf8"));
    return agentConsoleWriteChain;
  };

  await fs.mkdir(generateDir, { recursive: true });
  await store.setCase(caseName, {
    status: "running",
    stage: "preparing",
    startedAt: startedAt.toISOString(),
    runDir: caseRunDir,
    projectName: caseInfo.projectName,
    projectDir,
  });
  await writeAgentConsole("start", `开始执行；project=${projectDir}`);

  const updateState = async (values) => {
    const next = { case: caseName, ...store.state.cases[caseName], ...values, updatedAt: new Date().toISOString() };
    await atomicWriteJson(statePath, next);
    await store.setCase(caseName, values);
  };

  try {
    throwIfInterrupted(signal);
    const sourcePrompt = await fs.readFile(caseInfo.promptPath, "utf8");
    if (!sourcePrompt.trim()) throw new Error(`PROMPT.md 内容为空: ${caseInfo.promptPath}`);
    const prompt = `${sourcePrompt.trim()}\n\n${AGENT_SANDBOX_POLICY}\n\n${agentDeviceLeasePolicy(caseName, deviceLeasePath)}\n`;
    await fs.writeFile(path.join(generateDir, "input.txt"), prompt, "utf8");
    await copyProject(caseInfo.projectDir, originalDir);
    await copyProject(originalDir, projectDir);
    baseline = await initializeGitBaseline(projectDir);
    throwIfInterrupted(signal);
    reporter.caseProgress(caseName, "工程沙箱已就绪，正在创建 Agent 会话");
    await updateState({ stage: "session_creating", baseline });

    const session = await client.createSession(projectDir, SESSION_CREATE_TIMEOUT_SEC);
    sessionId = String(session?.id || "");
    if (!sessionId) throw new Error("OpenCode 创建 session 后未返回 session id");
    await atomicWriteJson(path.join(caseRunDir, "session.json"), {
      sessionId,
      projectName: caseInfo.projectName,
      projectDir,
      agent: execution.agent,
      providerId: model.providerId,
      modelId: model.modelId,
      createdAt: new Date().toISOString(),
    });
    await updateState({ stage: "agent_running", sessionId });
    reporter.caseProgress(caseName, "Agent 会话已创建，等待首个有效响应");
    await writeAgentConsole("session", `Agent 会话已创建；sessionId=${sessionId}`);

    let lastConsoleProgressAt = 0;
    const monitored = await runMonitoredSession({
      client,
      sessionId,
      projectDir,
      payload: {
        parts: [{ type: "text", text: prompt }],
        agent: execution.agent,
        model: { providerID: model.providerId, modelID: model.modelId },
      },
      eventsPath: path.join(generateDir, "opencode-sse.jsonl"),
      pollingPath: path.join(generateDir, "opencode-polling.jsonl"),
      idleTimeoutSec: execution.idleTimeoutSec,
      maxRuntimeSec: execution.maxRuntimeSec,
      signal,
      onProgress: (event, data) => {
        // 原始 SSE 已单独保存，避免在 execution.jsonl 中重复写入大量事件。
        if (event !== "sse") appendCaseLog(caseLogPath, "info", event, data).catch(() => {});
        if (data?.tokenUsage) {
          latestTokenUsage = data.tokenUsage;
          reporter.caseTokenUsage(caseName, latestTokenUsage);
          if (latestTokenUsage.total !== lastPersistedTokenTotal) {
            lastPersistedTokenTotal = latestTokenUsage.total;
            store.setCase(caseName, { tokenUsage: latestTokenUsage }).catch(() => {});
          }
        }
        if (data?.compileUsage) reporter.caseCompileUsage(caseName, data.compileUsage);
        if (event === "message" && data.changed && Date.now() - lastConsoleProgressAt > 2000) {
          lastConsoleProgressAt = Date.now();
          const detail = formatAgentProgress(data);
          reporter.caseProgress(caseName, detail);
          writeAgentConsole("progress", detail).catch(() => {});
        }
      },
    });

    await fs.writeFile(path.join(generateDir, "output.txt"), monitored.output || "", "utf8");
    await atomicWriteJson(path.join(generateDir, "final-message.json"), monitored.message || {});
    const agentLogs = await saveAgentLogs(client, [sessionId, ...monitored.childSessionIds], generateDir);
    const tokenUsage = agentLogs.tokenUsage.total ? agentLogs.tokenUsage : monitored.tokenUsage || latestTokenUsage;
    const agentCompile = agentLogs.agentCompile;
    reporter.caseTokenUsage(caseName, tokenUsage);
    reporter.caseCompileUsage(caseName, agentCompile);
    reporter.caseProgress(caseName, "Agent 已结束，正在生成结果和差异文件");
    await updateState({ stage: "artifacting", childSessionIds: monitored.childSessionIds });
    await generatePatch(projectDir, baseline, patchPath);

    const agentFinishedAt = new Date();
    const agentElapsedSec = Math.round((agentFinishedAt.getTime() - startedAt.getTime()) / 1000);
    const result = {
      case: caseName,
      status: ohosTestEnabled ? "running" : "completed",
      agentStatus: "completed",
      sessionId,
      childSessionIds: monitored.childSessionIds,
      agent: execution.agent,
      providerId: model.providerId,
      modelId: model.modelId,
      startedAt: startedAt.toISOString(),
      agentFinishedAt: agentFinishedAt.toISOString(),
      agentElapsedSec,
      ...(!ohosTestEnabled ? { finishedAt: agentFinishedAt.toISOString(), elapsedSec: agentElapsedSec } : {}),
      finishReason: monitored.finishReason,
      tokenUsage,
      agentCompile,
      originalDir,
      projectName: caseInfo.projectName,
      projectDir,
      patchPath,
      resultPath,
      outputPath: path.join(generateDir, "output.txt"),
      output: monitored.output || "",
      logs: {
        transcriptPath: agentLogs.transcriptPath,
        messagesPath: agentLogs.messagesPath,
        compileAttemptsPath: agentLogs.compileAttemptsPath,
        finalMessagePath: path.join(generateDir, "final-message.json"),
        ssePath: path.join(generateDir, "opencode-sse.jsonl"),
        pollingPath: path.join(generateDir, "opencode-polling.jsonl"),
        executionPath: caseLogPath,
        consolePath: agentConsolePath,
      },
      ...(ohosTestEnabled ? { ohosTest: { status: "queued" } } : {}),
    };
    const finalPreview = compactPreview(monitored.output, 500);
    if (finalPreview) await writeAgentConsole("final", finalPreview);
    await writeAgentConsole("complete", `执行完成；完整输出=${agentLogs.transcriptPath}`);
    await agentConsoleWriteChain;
    await atomicWriteJson(resultPath, result);
    if (ohosTestEnabled) {
      await updateState({
        status: "running",
        stage: "ohostest_queued",
        agentStatus: "completed",
        agentFinishedAt: result.agentFinishedAt,
        resultPath,
        patchPath,
        tokenUsage,
        agentCompile,
        ohosTest: result.ohosTest,
      });
      reporter.caseOhosTestQueued(caseName, { agentTimedOut: false });
    } else {
      await updateState({ status: "completed", stage: "completed", finishedAt: result.finishedAt, resultPath, patchPath, tokenUsage, agentCompile });
      reporter.caseFinished(result);
    }
    return result;
  } catch (error) {
    if (baseline && await exists(projectDir)) {
      await generatePatch(projectDir, baseline, patchPath).catch(() => {});
    }
    if (error.lastMessage) {
      await atomicWriteJson(path.join(generateDir, "last-message.json"), error.lastMessage).catch(() => {});
    }
    const failedSessionIds = [error.sessionId || sessionId, ...(error.childSessionIds || [])];
    const agentLogs = await saveAgentLogs(client, failedSessionIds, generateDir).catch(() => null);
    const tokenUsage = agentLogs?.tokenUsage?.total
      ? agentLogs.tokenUsage
      : error.tokenUsage || latestTokenUsage;
    const agentCompile = agentLogs?.agentCompile || emptyCompileUsage();
    reporter.caseTokenUsage(caseName, tokenUsage);
    reporter.caseCompileUsage(caseName, agentCompile);
    const interrupted = error.code === "AUTORUN_INTERRUPTED";
    const timedOut = /无活动|总运行时间超过/.test(error.message);
    const status = interrupted ? "interrupted" : timedOut ? "timed_out" : "failed";
    const result = {
      case: caseName,
      status,
      agentStatus: status,
      agentError: error.message,
      sessionId: error.sessionId || sessionId,
      childSessionIds: error.childSessionIds || [],
      error: error.message,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      elapsedSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
      tokenUsage,
      agentCompile,
      projectName: caseInfo.projectName,
      projectDir,
      resultPath,
      patchPath: await exists(patchPath) ? patchPath : "",
      logs: {
        transcriptPath: agentLogs?.transcriptPath || "",
        messagesPath: agentLogs?.messagesPath || "",
        compileAttemptsPath: agentLogs?.compileAttemptsPath || "",
        ssePath: path.join(generateDir, "opencode-sse.jsonl"),
        pollingPath: path.join(generateDir, "opencode-polling.jsonl"),
        executionPath: caseLogPath,
        consolePath: agentConsolePath,
      },
    };
    await writeAgentConsole(status, error.message).catch(() => {});
    await agentConsoleWriteChain.catch(() => {});
    await atomicWriteJson(resultPath, result);
    await updateState({ status, stage: status, error: error.message, finishedAt: result.finishedAt, resultPath, tokenUsage, agentCompile });
    reporter.caseFinished(result);
    throw Object.assign(error, { caseResult: result });
  }
}

async function canReuseSuccessfulAgent(previousResult, caseInfo) {
  if (!previousResult || previousResult.agentStatus !== "completed") return false;
  const previousProjectName = String(previousResult.projectName || path.basename(previousResult.projectDir || "")).trim();
  return previousProjectName === caseInfo.projectName
    && Boolean(previousResult.projectDir)
    && Boolean(previousResult.patchPath)
    && await exists(previousResult.projectDir)
    && await exists(previousResult.patchPath);
}

async function prepareReusedAgentResult({ caseInfo, batchRoot, previousResult, sourceBatchId, store }) {
  if (!await exists(previousResult.projectDir)) {
    throw new Error(`历史 Agent 工程不存在，无法仅重试 ohosTest: ${previousResult.projectDir}`);
  }
  if (!await exists(previousResult.patchPath)) {
    throw new Error(`历史 Agent patch 不存在，无法仅重试 ohosTest: ${previousResult.patchPath}`);
  }

  const caseRunDir = path.join(batchRoot, safeName(caseInfo.name));
  const projectDir = path.join(caseRunDir, caseInfo.projectName);
  const generateDir = path.join(caseRunDir, "generate");
  const diffDir = path.join(caseRunDir, "diff");
  const patchPath = path.join(diffDir, "changes.patch");
  const resultPath = path.join(caseRunDir, "result.json");
  const statePath = path.join(caseRunDir, "state.json");
  const executionPath = path.join(caseRunDir, "execution.jsonl");
  const startedAt = new Date().toISOString();

  await fs.mkdir(generateDir, { recursive: true });
  await fs.mkdir(diffDir, { recursive: true });
  await copyProject(previousResult.projectDir, projectDir);
  await fs.copyFile(previousResult.patchPath, patchPath);

  const result = {
    case: caseInfo.name,
    status: "running",
    agentStatus: "completed",
    agentReused: true,
    agentError: "",
    output: previousResult.output || "",
    startedAt,
    agentFinishedAt: startedAt,
    projectName: caseInfo.projectName,
    projectDir,
    runDir: caseRunDir,
    patchPath,
    resultPath,
    tokenUsage: emptyTokenUsage(),
    agentCompile: emptyCompileUsage(),
    retry: {
      sourceBatchId,
      sourceResultPath: previousResult.resultPath || "",
      mode: "ohostest_only",
    },
    reusedAgentTokenUsage: previousResult.tokenUsage || emptyTokenUsage(),
    reusedAgentCompile: previousResult.agentCompile || emptyCompileUsage(),
    logs: {
      transcriptPath: previousResult.logs?.transcriptPath || "",
      messagesPath: previousResult.logs?.messagesPath || "",
      executionPath,
      consolePath: previousResult.logs?.consolePath || "",
      sourceResultPath: previousResult.resultPath || "",
    },
    ohosTest: { status: "queued" },
  };
  await atomicWriteJson(resultPath, result);
  await atomicWriteJson(statePath, {
    ...result,
    stage: "ohostest_queued",
    updatedAt: startedAt,
  });
  await appendCaseLog(executionPath, "info", "retry_reused_agent", result.retry);
  await store.setCase(caseInfo.name, {
    status: "running",
    stage: "ohostest_queued",
    agentStatus: "completed",
    agentReused: true,
    runDir: caseRunDir,
    projectName: caseInfo.projectName,
    projectDir,
    patchPath,
    resultPath,
    retry: result.retry,
  });
  return result;
}

async function executeOhosTestForCase({ caseInfo, agentResult, settings, deviceLeasePath, store, reporter, signal }) {
  const caseName = caseInfo.name;
  const caseRunDir = path.dirname(agentResult.resultPath);
  const statePath = path.join(caseRunDir, "state.json");
  const caseLogPath = agentResult.logs?.executionPath || path.join(caseRunDir, "execution.jsonl");
  const startedAt = new Date().toISOString();
  reporter.caseOhosTestStarted(caseName);
  await appendCaseLog(caseLogPath, "info", "ohostest_started", {
    runnerRoot: settings.runnerRoot,
    runMode: settings.runMode,
  });
  await store.setCase(caseName, {
    status: "running",
    stage: "ohostest_running",
    ohosTest: { status: "running", startedAt },
  });
  const currentState = await readJson(statePath) || { case: caseName };
  await atomicWriteJson(statePath, {
    ...currentState,
    status: "running",
    stage: "ohostest_running",
    ohosTest: { status: "running", startedAt },
    updatedAt: new Date().toISOString(),
  });

  let ohosTest;
  try {
    ohosTest = await runOhosTest({
      settings,
      caseInfo,
      caseRunDir,
      patchPath: agentResult.patchPath,
      deviceLeasePath,
      signal,
    });
  } catch (error) {
    const interrupted = signal?.aborted;
    ohosTest = {
      status: interrupted ? "interrupted" : "failed",
      runnerVersion: settings.runnerVersion || "",
      runnerRoot: settings.runnerRoot,
      runMode: settings.runMode,
      startedAt,
      finishedAt: new Date().toISOString(),
      elapsedSec: elapsedSeconds(startedAt, new Date().toISOString()),
      error: error.message,
      outputDir: path.join(caseRunDir, ".ohostest-runs"),
      resultPath: "",
      summaryPath: "",
      consolePath: path.join(caseRunDir, "ohostest-runner-console.log"),
    };
  }

  const finishedAt = ohosTest.finishedAt || new Date().toISOString();
  const status = ohosTest.status === "completed" ? "completed" : ohosTest.status;
  // Agent 超时后仍允许 ohostest 验证已经保存在 base/ 或 task/ 的工程。最终状态由
  // ohostest 决定，但始终保留 Agent 的超时信息，避免测试通过后丢失诊断线索。
  const agentStatus = agentResult.agentStatus || "completed";
  const agentError = agentResult.agentError
    || (agentStatus === "timed_out" ? agentResult.error || "" : "");
  const finalResult = {
    ...agentResult,
    status,
    agentStatus,
    agentError,
    error: status === "completed" ? "" : ohosTest.error || `ohosTest ${status}`,
    finishedAt,
    elapsedSec: elapsedSeconds(agentResult.startedAt, finishedAt),
    ohosTest,
    logs: {
      ...agentResult.logs,
      ohosTestConsolePath: ohosTest.consolePath,
    },
  };
  await atomicWriteJson(agentResult.resultPath, finalResult);
  const finalState = {
    ...(await readJson(statePath) || { case: caseName }),
    status,
    stage: status,
    error: finalResult.error || "",
    agentStatus,
    agentError,
    finishedAt,
    resultPath: agentResult.resultPath,
    ohosTest,
    updatedAt: new Date().toISOString(),
  };
  await atomicWriteJson(statePath, finalState);
  await store.setCase(caseName, {
    status,
    stage: status,
    error: finalResult.error || "",
    finishedAt,
    resultPath: agentResult.resultPath,
    ohosTest,
  });
  await appendCaseLog(caseLogPath, status === "completed" ? "info" : "error", "ohostest_finished", ohosTest);
  reporter.caseFinished(finalResult);
  return finalResult;
}

async function validateServerConfig(client, execution, loadedConfig, sourceMode, signal) {
  const config = loadedConfig || await client.getConfig(120);
  if (config?.permission?.external_directory !== "deny") {
    console.warn("[warn] 当前运行中的 Server 未启用 external_directory=deny；若刚修改配置，请重启该 Server");
  }
  const usesBuiltInAgent = sourceMode === OPENCODE_SOURCE_MODES.SOFTWARE_ENGINEERING;
  if (!usesBuiltInAgent && !Object.hasOwn(config?.agent || {}, execution.agent)) {
    throw new Error(`Server 未配置 Agent: ${execution.agent}`);
  }
  if (execution.agent === "harmonyos-multi-device") {
    const agentPrompt = String(config.agent[execution.agent]?.prompt || "");
    if (!agentPrompt.includes("harmonyos-multi-device-adaptation/harmonyos-adaptation-workflow/SKILL.md")) {
      throw new Error("harmonyos-multi-device 插件未正确加载：运行时 Agent prompt 缺少一多适配工作流指令");
    }
    const skills = await waitForSkills(client, execution.casesRoot, { signal });
    const skillNames = new Set((Array.isArray(skills) ? skills : []).map((item) => String(item?.name || item?.id || "")));
    for (const required of ["harmonyos-adaptation-workflow", "harmonyos-responsive-layout"]) {
      if (!skillNames.has(required)) {
        throw new Error(`harmonyos-multi-device 关键 Skill 未注册: ${required}`);
      }
    }
  }
  for (const [providerId, provider] of Object.entries(config?.provider || {})) {
    if (Object.hasOwn(provider?.models || {}, execution.model)) {
      return { providerId, modelId: execution.model };
    }
  }
  throw new Error(`Server 未配置模型: ${execution.model}`);
}

async function runBatch(config, client, serverConfig, checkOnly = false, { signal, retryPlan } = {}) {
  throwIfInterrupted(signal);
  const sourceMode = config.server.opencodeSource.mode;
  const configuredAgent = String(config.execution.agent || "").trim();
  const execution = {
    ...config.execution,
    agent: sourceMode === OPENCODE_SOURCE_MODES.SOFTWARE_ENGINEERING ? "build" : configuredAgent,
    concurrency: Math.max(1, Number(config.execution.concurrency) || 1),
    consoleMode: String(config.execution.consoleMode || "dashboard").toLowerCase(),
    idleTimeoutSec: Math.max(1, Number(config.execution.idleTimeoutSec) || 600),
    maxRuntimeSec: Math.max(1, Number(config.execution.maxRuntimeSec) || 6000),
    continueOnError: config.execution.continueOnError !== false,
  };
  if (!execution.agent) throw new Error("未配置 execution.agent");
  const ohosTest = await loadOhosTestConfig(config);
  const discovered = await discoverCases(execution.casesRoot, { requireOhosTest: ohosTest.enabled });
  let cases = discovered.runnable;
  let skippedCases = discovered.skipped;
  if (retryPlan) {
    const runnableByName = new Map(cases.map((item) => [item.name, item]));
    const skippedByName = new Map(skippedCases.map((item) => [item.name, item]));
    const missing = retryPlan.selectedCaseNames.filter((name) => !runnableByName.has(name) && !skippedByName.has(name));
    if (missing.length) {
      throw new Error(`重试用例在当前 casesRoot 中不存在: ${missing.join(", ")}`);
    }
    const invalid = retryPlan.selectedCaseNames
      .map((name) => skippedByName.get(name))
      .filter(Boolean);
    if (invalid.length) {
      throw new Error(`重试用例当前不可执行: ${invalid.map((item) => `${item.name}（${item.skipReason}）`).join("；")}`);
    }
    cases = retryPlan.selectedCaseNames.map((name) => runnableByName.get(name));
    skippedCases = [];
  }
  const displayCases = [...cases, ...skippedCases];
  const model = await validateServerConfig(client, execution, serverConfig, sourceMode, signal);
  throwIfInterrupted(signal);
  const ohosTestLabel = ohosTest.enabled
    ? `已启用（串行，Runner=${ohosTest.runnerRoot}）`
    : "未启用";
  if (
    sourceMode === OPENCODE_SOURCE_MODES.SOFTWARE_ENGINEERING
    && configuredAgent
    && configuredAgent !== execution.agent
  ) {
    console.log(`[check] softwareEngineering 仅加载 Skills，使用 OpenCode 内置 Agent=${execution.agent}（忽略 execution.agent=${configuredAgent}）`);
  }
  console.log(`[check] 发现 ${displayCases.length} 个用例（可执行 ${cases.length}，跳过 ${skippedCases.length}）；Agent=${execution.agent}；模型=${model.providerId}/${model.modelId}；ohosTest=${ohosTestLabel}`);
  if (retryPlan) {
    console.log(`[retry] 来源批次 ${retryPlan.sourceBatchId}；重试用例: ${retryPlan.selectedCaseNames.join(", ")}`);
  }
  if (checkOnly) return { checked: true, caseCount: cases.length, skippedCases, ohosTest };

  const id = batchId();
  const batchRoot = path.join(execution.outputRoot, id);
  await fs.mkdir(batchRoot, { recursive: true });
  const state = {
    batchId: id,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    concurrency: execution.concurrency,
    ohosTest: {
      enabled: ohosTest.enabled,
      concurrency: ohosTest.enabled ? 1 : 0,
      runnerRoot: ohosTest.runnerRoot,
    },
    ...(retryPlan ? {
      retry: {
        sourceBatchId: retryPlan.sourceBatchId,
        requestedCaseName: retryPlan.requestedCaseName,
      },
    } : {}),
    cases: Object.fromEntries(displayCases.map((item) => [item.name, {
      status: item.skipReason ? "skipped" : "pending",
      stage: item.skipReason ? "skipped" : "queued",
      caseRoot: item.caseRoot,
      projectName: item.projectName,
      projectDir: item.projectDir,
      ...(item.skipReason ? { skipReason: item.skipReason } : {}),
      updatedAt: new Date().toISOString(),
    }])),
  };
  const store = new BatchStateStore(path.join(batchRoot, "batch.json"), state);
  await store.persist();
  const workerCount = Math.min(execution.concurrency, cases.length);
  const reporter = new ConsoleReporter({
    mode: execution.consoleMode,
    batchId: id,
    cases: displayCases,
    concurrency: workerCount,
    batchRoot,
  });
  activeReporter = reporter;
  reporter.start();
  const queue = [...cases];
  const results = [];
  const ohosTestJobs = [];
  let ohosTestTail = Promise.resolve();
  let stopQueue = false;

  function scheduleOhosTest(caseInfo, agentResult) {
    const scheduled = ohosTestTail.then(() => executeOhosTestForCase({
      caseInfo,
      agentResult,
      settings: ohosTest,
      deviceLeasePath: path.join(batchRoot, ".device-validation.lock"),
      store,
      reporter,
      signal,
    }));
    // 只有这一条 Promise 链会进入 Runner，确保模拟器启动和设备执行始终串行。
    ohosTestTail = scheduled.catch(() => {});
    ohosTestJobs.push(scheduled.then((finalResult) => {
      results.push(finalResult);
      if (finalResult.status !== "completed" && !execution.continueOnError) stopQueue = true;
    }).catch(async (error) => {
      const failed = {
        ...agentResult,
        status: signal?.aborted ? "interrupted" : "failed",
        error: `ohosTest 编排异常: ${error.message}`,
        finishedAt: new Date().toISOString(),
        ohosTest: { status: "failed", error: error.message },
      };
      failed.elapsedSec = elapsedSeconds(failed.startedAt, failed.finishedAt);
      await atomicWriteJson(agentResult.resultPath, failed).catch(() => {});
      await store.setCase(caseInfo.name, {
        status: failed.status,
        stage: failed.status,
        error: failed.error,
        finishedAt: failed.finishedAt,
        ohosTest: failed.ohosTest,
      }).catch(() => {});
      reporter.caseFinished(failed);
      results.push(failed);
      if (!execution.continueOnError) stopQueue = true;
    }));
  }

  async function worker(workerIndex) {
    while (!stopQueue && !signal?.aborted) {
      const next = queue.shift();
      if (!next) return;
      reporter.caseStarted(next.name, workerIndex);
      try {
        const previousResult = retryPlan?.previousResults.get(next.name);
        if (await canReuseSuccessfulAgent(previousResult, next)) {
          if (!ohosTest.enabled) {
            throw new Error(`用例 ${next.name} 的 Agent 已成功，只需重试 ohosTest，但当前 ohosTest.enabled=false`);
          }
          const agentResult = await prepareReusedAgentResult({
            caseInfo: next,
            batchRoot,
            previousResult,
            sourceBatchId: retryPlan.sourceBatchId,
            store,
          });
          reporter.caseOhosTestQueued(next.name);
          scheduleOhosTest(next, agentResult);
          continue;
        }
        const agentResult = await runCase({
          caseInfo: next,
          batchRoot,
          client,
          model,
          execution,
          ohosTestEnabled: ohosTest.enabled,
          store,
          reporter,
          signal,
        });
        if (ohosTest.enabled) scheduleOhosTest(next, agentResult);
        else results.push(agentResult);
      } catch (error) {
        const agentResult = error.caseResult || { case: next.name, status: "failed", error: error.message };
        // Agent 空闲/总时长超时不代表已生成工程不能编译。此时仍把现有 base/ 或 task/
        // 交给串行 ohostest 队列验证；用户中断时不再启动新的模拟器任务。
        const shouldRunOhosTestAfterAgentTimeout = (
          ohosTest.enabled
          && !signal?.aborted
          && agentResult.status === "timed_out"
          && agentResult.agentStatus === "timed_out"
        );
        if (shouldRunOhosTestAfterAgentTimeout) {
          reporter.caseOhosTestQueued(next.name, { agentTimedOut: true });
          scheduleOhosTest(next, agentResult);
        } else {
          results.push(agentResult);
          if (signal?.aborted || !execution.continueOnError) stopQueue = true;
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: workerCount }, (_, index) => worker(index + 1)),
  );
  await Promise.all(ohosTestJobs);

  if ((stopQueue || signal?.aborted) && queue.length) {
    const interrupted = signal?.aborted;
    const pendingStatus = "cancelled";
    const pendingError = interrupted
      ? "批次执行被中断，用例尚未开始执行"
      : "前序用例失败且 continueOnError=false";
    for (const pending of queue) {
      await store.setCase(pending.name, { status: pendingStatus, stage: pendingStatus, error: pendingError, finishedAt: new Date().toISOString() });
      reporter.caseCancelled(pending.name, pendingError);
      results.push({ case: pending.name, status: pendingStatus, error: pendingError });
    }
  }
  const failedCount = results.filter((item) => item.status !== "completed").length;
  const interrupted = signal?.aborted || results.some((item) => item.status === "interrupted");
  const tokenUsage = addTokenUsage(...results.map((item) => item.tokenUsage));
  const agentCompile = addCompileUsage(...results.map((item) => item.agentCompile));
  const summary = {
    batchId: id,
    status: interrupted ? "interrupted" : failedCount ? "completed_with_failures" : "completed",
    finishedAt: new Date().toISOString(),
    total: cases.length,
    completed: results.filter((item) => item.status === "completed").length,
    failed: failedCount,
    skipped: skippedCases.map((item) => ({ case: item.name, reason: item.skipReason })),
    tokenUsage,
    agentCompile,
    results,
    ...(retryPlan ? {
      retry: {
        sourceBatchId: retryPlan.sourceBatchId,
        requestedCaseName: retryPlan.requestedCaseName,
      },
    } : {}),
  };
  try {
    summary.reports = await writeBatchReport({ batchRoot, summary });
  } catch (error) {
    summary.reportError = error.message;
    console.warn(`[warn] 批次报告生成失败: ${error.message}`);
  }
  await atomicWriteJson(path.join(batchRoot, "summary.json"), summary);
  await store.setBatch({ status: summary.status, finishedAt: summary.finishedAt });
  reporter.finish(summary);
  if (activeReporter === reporter) activeReporter = null;
  return summary;
}

const args = parseArgs(process.argv.slice(2));
const config = await loadAutorunConfig(args.configPath);
const shutdownController = new AbortController();
let server;
let retryPlan;
let exitCode = 0;
let serverStopping = false;
let batchSettled = false;
let serverStopPromise;
let shutdownFallbackTimer;

function beginOwnedServerStop() {
  if (!server?.owned || config.server.stopWhenFinished === false) {
    return Promise.resolve();
  }
  serverStopping = true;
  serverStopPromise ??= stopOwnedServer(server);
  return serverStopPromise;
}

function requestShutdown(reason, cause) {
  if (shutdownController.signal.aborted) return;
  const error = interruptionError(cause || reason);
  if (cause instanceof Error && !error.message.includes(reason)) {
    error.message = `${reason}: ${cause.message}`;
  } else if (!(cause instanceof Error)) {
    error.message = String(reason);
  }
  activeReporter?.pauseDashboard();
  console.error(`[interrupt] ${error.message}；正在收尾运行中的用例`);
  shutdownController.abort(error);
  shutdownFallbackTimer = setTimeout(() => {
    console.warn("[interrupt] 用例收尾超过 10 秒，开始关闭 OpenCode Server");
    void beginOwnedServerStop();
  }, 10_000);
  exitCode = 1;
}

const onSigint = () => {
  if (shutdownController.signal.aborted) {
    console.warn("[interrupt] 正在清理进程和端口，请等待收尾完成");
    return;
  }
  requestShutdown("收到 SIGINT（Ctrl+C）");
};
const onSigterm = () => {
  if (shutdownController.signal.aborted) return;
  requestShutdown("收到 SIGTERM");
};
const onUncaughtException = (error) => requestShutdown("Autorun 出现未捕获异常", error);
const onUnhandledRejection = (reason) => requestShutdown(
  "Autorun 出现未处理的 Promise 拒绝",
  reason instanceof Error ? reason : new Error(String(reason)),
);
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
process.once("uncaughtException", onUncaughtException);
process.once("unhandledRejection", onUnhandledRejection);

try {
  checkLoadAgents(config);
  const recovered = await recoverInterruptedRuns(config.execution.outputRoot);
  for (const item of recovered) {
    console.warn(`[recovery] 已收尾上次未正常完成的批次: ${item.batchId}`);
  }
  if (args.retryBatchId) {
    retryPlan = await loadRetryPlan(config.execution.outputRoot, args.retryBatchId, args.retryCaseName);
  }
  server = await ensureOpenCodeServer(config, { signal: shutdownController.signal });
  if (server?.owned && server.child) {
    server.child.once("exit", (code, signal) => {
      if (serverStopping || batchSettled) return;
      requestShutdown(`OpenCode Server 意外退出（code=${code ?? "null"}, signal=${signal || "none"}）`);
    });
    server.child.once("error", (error) => {
      if (serverStopping || batchSettled) return;
      requestShutdown("OpenCode Server 子进程错误", error);
    });
  }
  const summary = await runBatch(config, server.client, server.serverConfig, args.checkOnly, {
    signal: shutdownController.signal,
    retryPlan,
  });
  batchSettled = true;
  if (!args.checkOnly && summary.failed) exitCode = 1;
} catch (error) {
  activeReporter?.pauseDashboard();
  console.error(`[error] ${error.stack || error.message}`);
  exitCode = 1;
} finally {
  clearTimeout(shutdownFallbackTimer);
  await beginOwnedServerStop();
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  process.removeListener("uncaughtException", onUncaughtException);
  process.removeListener("unhandledRejection", onUnhandledRejection);
}
process.exitCode = exitCode;

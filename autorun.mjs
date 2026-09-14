#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { OpenCodeClient } from "./src/opencode/opencode-client.mjs";
import { runMonitoredSession, isQuotaExceededMessage } from "./src/agent/session-monitor.mjs";
import { copyProject } from "./src/runtime/sandbox-copy.mjs";
import { ConsoleReporter } from "./src/runtime/console-reporter.mjs";
import { addTokenUsage, aggregateSessionMessages, emptyTokenUsage } from "./src/agent/token-usage.mjs";
import { addCompileUsage, collectCompileAttempts, emptyCompileUsage } from "./src/agent/compile-usage.mjs";
import { loadOhosTestConfig, runOhosTest } from "./src/ohostest/autorun/orchestrator.mjs";
import { loadCloudTestConfig, submitCloudTestForProject, finishCloudTestPolling } from "./src/cloudtest/cloudtest-orchestrator.mjs";
import { writeBatchReport } from "./src/report/batch-report.mjs";
import { OPENCODE_SOURCE_MODES, resolveOpenCodeSource } from "./src/opencode/opencode-installation.mjs";
import { mergeOverview } from "./src/report/merge-overview.mjs";
import { serverAllowsEverything, serverAllowsExecution } from "./src/agent/permission-policy.mjs";
import { detectDevEcoCli, formatDevEcoCliFailure } from "./src/platform/deveco-cli.mjs";
import { writeAutorunStartupSummary } from "./src/platform/autorun-console-output.mjs";
import {
  prepareAgentSkillRuntime,
  summarizeAgentSkillRuntime,
  installProjectSkill,
  inspectSkillWorkflow,
} from "./src/agent/agent-skill-runtime.mjs";
import {
  AGENT_AUTO_APPROVAL_POLICY,
  hasAgentSessionPolicy,
} from "./src/agent/session-policy.mjs";
import { normalizeAgentTargets, normalizeGenerationModel } from "./src/agent/agent-targets.mjs";
import { resolveConfiguredModel } from "./src/agent/model-validation.mjs";
import { writeAgentComparisonReport } from "./src/report/agent-comparison-report.mjs";
import {
  filterGeneratedArtifactPatch,
  GENERATED_ARTIFACT_GIT_EXCLUDES,
  pruneGeneratedArtifacts,
} from "./src/artifacts/generated-artifact-filter.mjs";
import {
  bindHarmonyBotWhiteboxRuntime,
  createWhiteboxOrchestrator,
  normalizeWhiteboxConfig,
  prepareWhiteboxInput,
} from "./src/whitebox/autorun/orchestrator.mjs";

const AUTORUN_ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_ROOT = path.join(AUTORUN_ROOT, "output");
const SKILL_REQUEST_TIMEOUT_SEC = 30;
const SKILL_READY_TIMEOUT_SEC = 180;
const SKILL_RETRY_INTERVAL_MS = 2_000;
const SESSION_CREATE_TIMEOUT_SEC = 120;
let activeReporter = null;
const silentLog = () => {};

function parseArgs(argv) {
  const result = {
    configPath: "./config/autorun.config.json",
    checkOnly: false,
    retryBatchId: "",
    retryCaseName: "",
    merge: undefined,
    cloudTest: false,
    cloudProjectName: "",
    cloudProjectDir: "",
    appPath: "",
    taskName: "",
    pollTask: "",
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
    } else if (value === "--cloud-test") {
      result.cloudTest = true;
    } else if (value === "--project") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("--project 需要工程目录名（base 或 task）");
      result.cloudProjectName = argv[++index];
    } else if (value === "--project-dir") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("--project-dir 需要工程目录路径");
      result.cloudProjectDir = argv[++index];
    } else if (value === "--app") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("--app 需要 .app 文件路径");
      result.appPath = argv[++index];
    } else if (value === "--task-name") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("--task-name 需要任务名称");
      result.taskName = argv[++index];
    } else if (value === "--poll-task") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("--poll-task 需要任务组 ID");
      result.pollTask = argv[++index];
    } else if (value === "--merge") {
      // 可选根目录：下一个 token 存在且不是 flag 则当作根目录，否则用 config 的 outputRoot
      if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
        result.merge = argv[++index];
      } else {
        result.merge = "";
      }
    } else if (value === "--help" || value === "-h") {
      console.log([
        "用法:",
        "  node autorun.mjs [--config config/autorun.config.json] [--check]",
        "  node autorun.mjs --retry <batchId> [--case <caseName>] [--config config/autorun.config.json]",
        "  node autorun.mjs --merge [output目录] [--config config/autorun.config.json]",
        "  node autorun.mjs --cloud-test (--case <caseName> [--project base|task] | --project-dir <dir> | --app <签名.app>) [--task-name <名称>] [--config config/autorun.config.json]",
        "  node autorun.mjs --poll-task <taskGroupId> [--config config/autorun.config.json]",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${value}`);
    }
  }
  if (result.retryCaseName && !result.retryBatchId && !result.cloudTest) throw new Error("--case 只能和 --retry 或 --cloud-test 一起使用");
  if (result.checkOnly && result.retryBatchId) throw new Error("--check 不能和 --retry 一起使用");
  if (result.merge !== undefined && result.checkOnly) throw new Error("--merge 不能和 --check 一起使用");
  if (result.merge !== undefined && result.retryBatchId) throw new Error("--merge 不能和 --retry 一起使用");
  if (result.cloudTest) {
    if (result.checkOnly) throw new Error("--cloud-test 不能和 --check 一起使用");
    if (result.retryBatchId) throw new Error("--cloud-test 不能和 --retry 一起使用");
    if (result.merge !== undefined) throw new Error("--cloud-test 不能和 --merge 一起使用");
    if (result.pollTask) throw new Error("--cloud-test 不能和 --poll-task 一起使用");
    if (!result.retryCaseName && !result.cloudProjectDir && !result.appPath) {
      throw new Error("--cloud-test 需要 --case <用例名>、--project-dir <工程目录> 或 --app <签名.app 文件> 之一");
    }
    if (result.cloudProjectDir && result.retryCaseName) throw new Error("--project-dir 不能和 --case 一起使用");
  } else if (result.pollTask) {
    if (result.checkOnly) throw new Error("--poll-task 不能和 --check 一起使用");
    if (result.retryBatchId) throw new Error("--poll-task 不能和 --retry 一起使用");
    if (result.merge !== undefined) throw new Error("--poll-task 不能和 --merge 一起使用");
    if (!/^\d+$/.test(result.pollTask)) throw new Error("--poll-task 需要纯数字任务组 ID");
  } else if (result.cloudProjectName || result.cloudProjectDir || result.appPath || result.taskName) {
    throw new Error("--project/--project-dir/--app/--task-name 只能和 --cloud-test 一起使用");
  }
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
  const targetConfig = normalizeAgentTargets(normalized.server.opencodeSource, { baseDir });
  normalized.server.opencodeTargets = targetConfig;
  // 下游单 Agent 逻辑继续读取 opencodeSource；串行编排时会为每个 target
  // 克隆配置并覆盖为当前来源。
  normalized.server.opencodeSource = { ...targetConfig.targets[0] };
  normalized.execution.casesRoot = resolveFrom(baseDir, normalized.execution.casesRoot || "./cases");
  normalized.execution.outputRoot = resolveFrom(
    baseDir,
    normalized.execution.outputRoot || OUTPUT_ROOT,
  );
  normalized.server.runtimeRoot = resolveFrom(
    baseDir,
    normalized.server.runtimeRoot || path.join(normalized.execution.outputRoot, "_runtime", "opencode"),
  );
  const generationModel = normalizeGenerationModel(normalized.execution, {
    requireProvider: targetConfig.multiple,
  });
  normalized.execution.model = generationModel.modelId;
  normalized.execution.providerId = generationModel.providerId;
  normalized.execution.generationModel = generationModel;
  normalized.whiteboxEvaluation = bindHarmonyBotWhiteboxRuntime(
    normalizeWhiteboxConfig(
      normalized.whiteboxEvaluation,
      normalized.execution.outputRoot,
    ),
    targetConfig.targets,
    baseDir,
  );
  normalized.upload = { enabled: normalized.upload?.enabled === true };
  return normalized;
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

  while (Date.now() < deadline) {
    throwIfInterrupted(signal);
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
      await delay(Math.min(retryIntervalMs, deadline - Date.now()));
    }
  }

  const detail = lastError?.message ? `；最后一次错误: ${lastError.message}` : "";
  throw new Error(`OpenCode Server Skill 加载超时（${timeoutSec} 秒）${detail}`, { cause: lastError });
}

async function ensureOpenCodeServerFromSource(config, source, {
  log = silentLog,
  signal,
  reuseExisting = true,
  workspace = AUTORUN_ROOT,
  isolateConfig = false,
} = {}) {
  if (signal?.aborted) throw interruptionError(signal.reason);
  log(`[server] OpenCode 来源模式: ${source.mode}`);
  const configuredServerUrl = String(config.server.url || "").trim();
  if (!configuredServerUrl) throw new Error("未配置 server.url");
  let serverUrl = configuredServerUrl;
  let client = new OpenCodeClient(serverUrl);
  if (reuseExisting && await client.health()) {
    log("[server] 健康检查通过，正在等待 Agent、Plugin、Skill 和 Provider 配置加载");
    const serverConfig = await waitForServerConfig(client, { signal });
    const expectedAgent = source.mode === OPENCODE_SOURCE_MODES.SOFTWARE_ENGINEERING
      ? "build"
      : String(config.execution?.agent || "").trim();
    const reusable = source.mode === OPENCODE_SOURCE_MODES.HARMONY_BOT
      ? Object.hasOwn(serverConfig?.agent || {}, expectedAgent)
      : serverAllowsEverything(serverConfig, expectedAgent) && hasAgentSessionPolicy(serverConfig, expectedAgent);
    if (reusable) {
      log(`[server] 复用已运行的 OpenCode Server: ${serverUrl}`);
      return { client, serverConfig, owned: false, child: null, logPath: "", source };
    }
    log(`[server] 已运行的 OpenCode Server 与当前 Agent 来源不匹配，改为启动独立 Server`);
  } else if (!reuseExisting && await client.health()) {
    log("[server] 隔离执行不复用已有 OpenCode Server，将自动选择独立端口");
  }

  serverUrl = await selectAvailableServerUrl(configuredServerUrl);
  if (serverUrl !== configuredServerUrl.replace(/\/$/, "")) {
    log(`[server] 配置端口不可用，自动改用: ${serverUrl}`);
    client = new OpenCodeClient(serverUrl);
  }

  const runtimeRoot = config.server.runtimeRoot;
  await fs.mkdir(runtimeRoot, { recursive: true });
  const port = new URL(serverUrl).port || "61417";
  const runId = `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-autorun-serve`;
  const logDir = path.join(runtimeRoot, "logs", "runs", runId);
  const logPath = path.join(logDir, "opencode-server.log");
  await fs.mkdir(logDir, { recursive: true });
  const logFile = await fs.open(logPath, "a");
  let args;
  if (source.mode === OPENCODE_SOURCE_MODES.HARMONY_BOT) {
    args = [
      source.serverLauncherPath,
      "--root", source.installation.extensionDir,
      "--workspace", workspace,
      "--port", port,
    ];
  } else {
    const serveScript = fileURLToPath(new URL("./src/opencode/run-opencode-serve.mjs", import.meta.url));
    if (!await exists(serveScript)) throw new Error(`启动脚本不存在: ${serveScript}`);
    const sessionPolicyPath = path.join(runtimeRoot, "session-policy.md");
    await fs.writeFile(sessionPolicyPath, `${AGENT_AUTO_APPROVAL_POLICY}\n`, "utf8");
    args = [
      serveScript,
      "--source", source.resourcesDir,
      "--assets-source", source.assetsDir,
      "--opencode-bin", source.opencodeBinPath,
      "--runtime-root", runtimeRoot,
      "--workspace", workspace,
      "--port", port,
      "--session-agent", String(config.execution.agent || "").trim(),
      "--session-policy-file", sessionPolicyPath,
    ];
    if (isolateConfig) args.push("--isolate-config");
    args.push("--strict-source-skills");
    if (config.server.providerOverlayPath) {
      args.push("--provider-overlay", config.server.providerOverlayPath);
    }
  }
  if (config.server.devecoHome) args.push("--deveco-home", config.server.devecoHome);

  if (source.mode === OPENCODE_SOURCE_MODES.HARMONY_BOT) {
    log(`[server] 使用 HarmonyBot 扩展 ${source.installation.version}: ${source.installation.extensionDir}`);
    log(`[server] Bundle 解析和 Skill 加载委托给插件启动器: ${source.serverLauncherPath}`);
  } else {
    log(`[server] 使用 Software Engineering 资源: ${source.root}`);
  }
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: config.__baseDir,
      env: source.mode === OPENCODE_SOURCE_MODES.HARMONY_BOT
        ? {
          ...process.env,
          OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
          OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
        }
        : process.env,
      stdio: ["ignore", logFile.fd, logFile.fd, "ipc"],
      windowsHide: true,
    });
  } finally {
    await logFile.close();
  }

  let toolResources;
  child.on("message", (message) => {
    if (message?.type === "autorun:tool-runtime") toolResources = message.resources;
  });
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
      const initializationHint = source.mode === OPENCODE_SOURCE_MODES.HARMONY_BOT
        ? `；请先在 VS Code 中启动并初始化 HarmonyBot ${source.installation.version}`
        : "";
      const error = new Error(`OpenCode Server 启动后提前退出（code=${child.exitCode}），日志: ${logPath}${initializationHint}`);
      error.code = "OPENCODE_SERVER_EARLY_EXIT";
      throw error;
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
  if (source.mode === OPENCODE_SOURCE_MODES.HARMONY_BOT) {
    toolResources = {
      env: { PATH: process.env.PATH || "" },
      toolReadRoots: [],
    };
  }
  return { client, serverConfig, owned: true, child, logPath, serverUrl, toolResources, source };
}

async function ensureOpenCodeServer(config, options = {}) {
  const source = await resolveOpenCodeSource(config.server.opencodeSource);
  return ensureOpenCodeServerFromSource(config, source, options);
}

async function stopOwnedServer(server, { log = silentLog } = {}) {
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
    log(`[warn] OpenCode Server 已结束，但端口仍未释放: ${server.serverUrl}`);
  }
}

// 批次 ID = 批次启动时间戳（YYYYMMDDHHmmss），目录为 <outputRoot>/<批次ID>/<agentId>。
// 同秒冲突时由 allocateRunDirectory 追加序号保证唯一。
function batchId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeName(value) {
  return String(value || "case").replace(/[^0-9A-Za-z._-]+/g, "_").slice(0, 120) || "case";
}

// 报告中的 Agent 来源分类：softwareEngineering 模式按来源 skills 是否为空
// 区分 softwareEngineering（含 Skills）与 baseModel（纯基座模型）。
async function resolveBatchModeDirectoryName(source) {
  if (source?.mode !== OPENCODE_SOURCE_MODES.SOFTWARE_ENGINEERING) return source?.mode || "default";
  const resolved = await resolveOpenCodeSource(source);
  const entries = await fs.readdir(path.join(resolved.assetsDir, "skills")).catch(() => []);
  return entries.length ? OPENCODE_SOURCE_MODES.SOFTWARE_ENGINEERING : "baseModel";
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

async function allocateRunDirectory(outputRoot) {
  await fs.mkdir(outputRoot, { recursive: true });
  const baseId = batchId();
  let id = baseId;
  for (let attempt = 2; await exists(path.join(outputRoot, id)); attempt += 1) {
    id = `${baseId}-${attempt}`;
  }
  const runRoot = path.join(outputRoot, id);
  await fs.mkdir(runRoot);
  return { runId: id, runRoot };
}

function targetRuntimeRoot(config, runId, targetId) {
  return path.join(config.server.runtimeRoot, runId, safeName(targetId));
}

function configForTarget(config, target, runId, casesRoot, phase = "") {
  const targetConfig = structuredClone(config);
  const baseRuntimeRoot = targetRuntimeRoot(config, runId, target.id);
  const runtimeRoot = phase ? path.join(baseRuntimeRoot, safeName(phase)) : baseRuntimeRoot;
  targetConfig.server.opencodeSource = { ...target };
  targetConfig.server.runtimeRoot = path.join(runtimeRoot, "opencode");
  targetConfig.execution.agent = target.agent;
  targetConfig.execution.casesRoot = casesRoot;
  targetConfig.whiteboxEvaluation.runtimeRoot = path.join(runtimeRoot, "whitebox");
  return { config: targetConfig, runtimeRoot };
}

async function fingerprintDirectory(root) {
  const entries = [];
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isSymbolicLink()) {
        entries.push({ relative, type: "link", value: await fs.readlink(absolute) });
      } else if (entry.isFile()) {
        entries.push({ relative, type: "file", absolute });
      }
    }
  };
  await visit(root);
  entries.sort((left, right) => left.relative.localeCompare(right.relative));
  const hash = createHash("sha256");
  for (const entry of entries) {
    const value = entry.type === "file" ? await fs.readFile(entry.absolute) : entry.value;
    hash.update(entry.type).update("\0").update(entry.relative).update("\0").update(value).update("\0");
  }
  return { sha256: hash.digest("hex"), fileCount: entries.length };
}

async function prepareSharedGenerationProvider(config, runId) {
  const { providerId, modelId } = config.execution.generationModel;
  const preferredTargetId = String(config.execution.providerSourceTargetId || "").trim();
  const targets = config.server.opencodeTargets.targets;
  if (preferredTargetId && !targets.some((target) => target.id === preferredTargetId)) {
    throw new Error(`execution.providerSourceTargetId 不存在: ${preferredTargetId}`);
  }
  const orderedTargets = preferredTargetId
    ? [
      ...targets.filter((target) => target.id === preferredTargetId),
      ...targets.filter((target) => target.id !== preferredTargetId),
    ]
    : targets;
  let selected;
  for (const target of orderedTargets) {
    const source = await resolveOpenCodeSource(target);
    const rawConfig = await readJson(path.join(source.resourcesDir, "opencode.json"));
    const provider = rawConfig?.provider?.[providerId];
    if (!provider || !Object.hasOwn(provider?.models || {}, modelId)) continue;
    selected = {
      targetId: target.id,
      provider: {
        ...provider,
        models: { [modelId]: provider.models[modelId] },
      },
    };
    break;
  }
  if (!selected) {
    return "";
  }
  const overlayPath = path.join(config.server.runtimeRoot, runId, "shared", "generation-provider.json");
  await atomicWriteJson(overlayPath, { providerId, provider: selected.provider });
  await fs.chmod(overlayPath, 0o600).catch(() => {});
  return overlayPath;
}

async function createSharedCasesSnapshot(config, runId, runRoot) {
  const snapshotRoot = path.join(config.server.runtimeRoot, runId, "shared", "cases");
  await copyProject(config.execution.casesRoot, snapshotRoot);
  const fingerprint = await fingerprintDirectory(snapshotRoot);
  await atomicWriteJson(path.join(runRoot, "input-snapshot.json"), {
    schemaVersion: "autorun-input-snapshot-v1",
    sourceCasesRoot: config.execution.casesRoot,
    snapshotRoot,
    ...fingerprint,
    createdAt: new Date().toISOString(),
  });
  return snapshotRoot;
}

function sanitizedConfigFingerprint(value) {
  const secretKey = /(api[-_]?key|token|secret|password|authorization|cookie|credential)/i;
  const clean = (item) => {
    if (Array.isArray(item)) return item.map(clean);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, secretKey.test(key) ? "<redacted>" : clean(item[key])]));
  };
  return createHash("sha256").update(JSON.stringify(clean(value))).digest("hex");
}

async function writeTargetEnvironmentManifest({
  targetRoot,
  target,
  targetConfig,
  source,
  server,
  model,
  signal,
  environmentFailures = [],
}) {
  const skills = await waitForSkills(server.client, targetConfig.execution.casesRoot, { signal });
  const registeredSkills = (Array.isArray(skills) ? skills : [])
    .map((item) => String(item?.name || item?.id || "").trim())
    .filter(Boolean)
    .sort();
  if (target.mode === OPENCODE_SOURCE_MODES.HARMONY_BOT) {
    server.toolResources ||= { env: { PATH: process.env.PATH || "" }, toolReadRoots: [] };
    server.toolResources.skillNames = registeredSkills;
  }
  server.skillRuntime = await prepareAgentSkillRuntime({
    resources: server.toolResources,
    registeredSkills: Array.isArray(skills) ? skills : [],
    agent: targetConfig.execution.agent,
    sourceMode: target.mode,
    signal,
  });
  if (server.skillRuntime.oneMulti?.devecoCli?.status === "unavailable") {
    environmentFailures.push(
      `${target.label || target.id} devecocli：${server.skillRuntime.oneMulti.devecoCli.warning}`,
    );
  }
  if (!Array.isArray(server.toolResources?.skillNames)) {
    throw new Error(`Agent ${target.id} Server 未返回私有 Skill 快照清单`);
  }
  const sourceSkills = [...new Set(server.toolResources.skillNames
    .map((name) => String(name || "").trim())
    .filter(Boolean))]
    .sort();
  let loadedSkills = registeredSkills;
  let blockedSkills = [];
  if (target.mode === OPENCODE_SOURCE_MODES.SOFTWARE_ENGINEERING) {
    const sourceSet = new Set(sourceSkills);
    const registeredSet = new Set(registeredSkills);
    const missing = sourceSkills.filter((name) => !registeredSet.has(name));
    if (missing.length) {
      throw new Error(`Agent ${target.id} 来源 Skill 未注册: ${missing.join(", ")}`);
    }
    const agentPermission = server.serverConfig?.agent?.[targetConfig.execution.agent]?.permission;
    const skillPermission = (agentPermission || server.serverConfig?.permission)?.skill;
    const allowedByPermission = Object.entries(skillPermission || {})
      .filter(([name, action]) => name !== "*" && action === "allow")
      .map(([name]) => name)
      .sort();
    if (skillPermission?.["*"] !== "deny"
      || JSON.stringify(allowedByPermission) !== JSON.stringify(sourceSkills)) {
      throw new Error(`Agent ${target.id} 未应用来源 Skill 精确白名单`);
    }
    loadedSkills = registeredSkills.filter((name) => sourceSet.has(name));
    blockedSkills = registeredSkills.filter((name) => !sourceSet.has(name));
  } else if (!sourceSkills.length && loadedSkills.length) {
    throw new Error(`Agent ${target.id} 来源 skills 为空，但 Server 实际加载了 Skill: ${loadedSkills.join(", ")}`);
  }
  const provider = server.serverConfig?.provider?.[model.providerId] || {};
  const manifest = {
    schemaVersion: "autorun-agent-environment-v1",
    targetId: target.id,
    label: target.label,
    mode: target.mode,
    agent: targetConfig.execution.agent,
    generationModel: {
      ...model,
      // HarmonyBot 新版通过 /config/providers 动态提供模型目录，静态
      // provider.models 可能为空；统一模型校验以实际选择的 ID 为准。
      configFingerprint: sanitizedConfigFingerprint(model),
    },
    source: {
      root: source.root,
      resourcesDir: source.resourcesDir,
      opencodeBinPath: source.opencodeBinPath,
      ...(source.mode === OPENCODE_SOURCE_MODES.SOFTWARE_ENGINEERING
        ? { assetsDir: source.assetsDir }
        : { serverLauncherPath: source.serverLauncherPath }),
      version: source.installation?.version || "",
      configFingerprint: sanitizedConfigFingerprint({
        opencode: server.serverConfig,
        provider,
        model: provider?.models?.[model.modelId],
      }),
    },
    isolation: {
      dedicatedServer: true,
      runtimeRoot: target.mode === OPENCODE_SOURCE_MODES.SOFTWARE_ENGINEERING
        ? targetConfig.server.runtimeRoot
        : "plugin-managed",
      workspace: path.join(path.dirname(targetConfig.server.runtimeRoot), "workspace"),
      configAssets: target.mode === OPENCODE_SOURCE_MODES.SOFTWARE_ENGINEERING
        ? "copied_snapshot"
        : "plugin_managed",
      skillPolicy: target.mode === OPENCODE_SOURCE_MODES.SOFTWARE_ENGINEERING
        ? "strict_source_allowlist"
        : "plugin_loaded_locations",
    },
    skills: {
      sourceDirectories: sourceSkills,
      loaded: loadedSkills,
      ...(blockedSkills.length ? { blocked: blockedSkills } : {}),
    },
    skillRuntime: summarizeAgentSkillRuntime(server.skillRuntime),
    createdAt: new Date().toISOString(),
  };
  await atomicWriteJson(path.join(targetRoot, "environment.json"), manifest);
  return manifest;
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

const FINISHED_CASE_STATUSES = new Set(["completed", "failed", "timed_out", "rate_limited", "cancelled", "interrupted"]);

// 兜底：SSE 事件流异常中断时（如连接闪断），从落盘的 opencode-sse.jsonl
// 逐行识别 session.status 的限额提示，避免漏判 rate_limited。
async function sseLogIndicatesQuota(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    for (const line of text.split("\n")) {
      if (line.includes("session.status") && isQuotaExceededMessage(line)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function loadRetryPlan(outputRoot, batchId, requestedCaseName = "") {
  const normalizedBatchId = String(batchId || "").trim().replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const resolvedOutputRoot = path.resolve(outputRoot);
  const relativeFor = (relative) => path.relative(resolvedOutputRoot, path.resolve(resolvedOutputRoot, relative));
  const isValidBatchRef = (relative) => {
    const relativeBatchPath = relativeFor(relative);
    return Boolean(relative)
      && !path.isAbsolute(relativeBatchPath)
      && Boolean(relativeBatchPath)
      && relativeBatchPath !== ".."
      && !relativeBatchPath.startsWith(`..${path.sep}`)
      && relativeBatchPath.split(path.sep).length <= 2;
  };
  if (!normalizedBatchId || !isValidBatchRef(normalizedBatchId)) {
    throw new Error(`无效的重试批次 ID: ${batchId || "<empty>"}`);
  }

  let sourceBatchRoot = path.resolve(resolvedOutputRoot, normalizedBatchId);
  if (!await exists(path.join(sourceBatchRoot, "batch.json")) && !normalizedBatchId.includes("/")) {
    // 兼容旧版 <来源>/<批次>，并支持新版在只有一个 Agent 时省略
    // `<agentId>`，直接通过 `<批次>` 查找。
    const matches = [];
    const runRoot = path.join(resolvedOutputRoot, normalizedBatchId);
    for (const target of await fs.readdir(runRoot, { withFileTypes: true }).catch(() => [])) {
      if (!target.isDirectory()) continue;
      const candidate = path.join(runRoot, target.name);
      if (await exists(path.join(candidate, "batch.json"))) matches.push(candidate);
    }
    for (const entry of await fs.readdir(resolvedOutputRoot, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(resolvedOutputRoot, entry.name, normalizedBatchId);
      if (await exists(path.join(candidate, "batch.json"))) matches.push(candidate);
    }
    if (matches.length === 1) sourceBatchRoot = matches[0];
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

// 判断 pid 是否仍在运行（batch.pid 存在且进程活着 → 批次仍在本机执行，不参与恢复）
function isProcessAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function recoverInterruptedRuns(outputRoot) {
  if (!await exists(outputRoot)) return [];
  const recovered = [];
  // 收集遗留 Agent 批次目录：兼容旧版 <来源>/<批次> 与新版 <批次>/<agentId>。
  const batchDirs = [];
  const topEntries = await fs.readdir(outputRoot, { withFileTypes: true });
  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    const entryRoot = path.join(outputRoot, entry.name);
    if (await exists(path.join(entryRoot, "batch.json"))) {
      batchDirs.push(entryRoot);
      continue;
    }
    for (const nested of await fs.readdir(entryRoot, { withFileTypes: true }).catch(() => [])) {
      if (!nested.isDirectory()) continue;
      const nestedRoot = path.join(entryRoot, nested.name);
      if (await exists(path.join(nestedRoot, "batch.json"))) batchDirs.push(nestedRoot);
    }
  }
  for (const batchRoot of batchDirs) {
    const batchPath = path.join(batchRoot, "batch.json");
    const batch = await readJson(batchPath);
    if (!batch || batch.status !== "running" || !batch.cases || typeof batch.cases !== "object") continue;
    // 活进程持有中的批次不是遗留状态（如长时间云测试轮询期间 batch.json 不更新），跳过
    const pidFile = path.join(batchRoot, "batch.pid");
    const pidText = (await fs.readFile(pidFile, "utf8").catch(() => "")).trim();
    if (pidText && isProcessAlive(pidText)) continue;

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
          consolePath: path.join(generateDir, "agent-console.log"),
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
    const representativeResult = results.find((item) => item?.agent || item?.modelId || item?.providerId);
    const summary = {
      batchId: batch.batchId || path.basename(batchRoot),
      status: "interrupted",
      finishedAt: recoveredAt,
      recoveredAt,
      agent: batch.agent || representativeResult?.agent || "",
      opencodeSourceMode: batch.opencodeSourceMode || "",
      providerId: batch.providerId || representativeResult?.providerId || "",
      modelId: batch.modelId || representativeResult?.modelId || "",
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
      summary.reports = await writeBatchReport({
        batchRoot,
        summary,
        uploadConfig: config.upload,
        onLog: silentLog,
      });
    } catch (error) {
      summary.reportError = error.message;
    }
    await atomicWriteJson(path.join(batchRoot, "summary.json"), summary);
    await atomicWriteJson(batchPath, batch);
    recovered.push({ batchId: batch.batchId || path.basename(batchRoot), batchRoot });
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
  return {
    messagesPath,
    transcriptPath,
    compileAttemptsPath,
    tokenUsage,
    agentCompile,
    agentCompileAttempts: compileAttempts.items,
  };
}

async function initializeGitBaseline(projectDir) {
  await runCommand("git", ["init"], { cwd: projectDir });
  await runCommand("git", ["config", "user.name", "autorun"], { cwd: projectDir });
  await runCommand("git", ["config", "user.email", "autorun@example.local"], { cwd: projectDir });
  const excludePath = path.join(projectDir, ".git", "info", "exclude");
  await fs.appendFile(
    excludePath,
    `\n.opencode/\nnode_modules/\nbuild/\n${GENERATED_ARTIFACT_GIT_EXCLUDES.join("\n")}\n`,
    "utf8",
  );
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
  const filteredPatch = filterGeneratedArtifactPatch(diff.stdout.toString("utf8"));
  await fs.writeFile(patchPath, filteredPatch, "utf8");
}

const GENERATED_PROJECT_DIRS = new Set([".git", ".hvigor", "build", "node_modules"]);

async function removeOutputPath(target) {
  if (!target) return;
  await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

async function pruneGeneratedProjectDirs(rootDir) {
  if (!rootDir || !await exists(rootDir)) return;
  const visit = async (currentDir) => {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const target = path.join(currentDir, entry.name);
      if (GENERATED_PROJECT_DIRS.has(entry.name)) {
        await removeOutputPath(target);
      } else {
        await visit(target);
      }
    }
  };
  await visit(rootDir);
}

async function cleanupCaseArtifacts({
  caseName,
  originalDir = "",
  projectDir = "",
  patchPath = "",
  generateDir = "",
  removeRawAgentLogs = false,
  pruneProject = false,
  keepOriginal = false,
  pruneTransientArtifacts = false,
}) {
  const failures = [];
  const attempt = async (label, action) => {
    try {
      await action();
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
    }
  };

  if (!keepOriginal && originalDir && patchPath && await exists(patchPath)) {
    await attempt("删除 original", () => removeOutputPath(originalDir));
  }
  if (removeRawAgentLogs && generateDir) {
    await attempt("删除 SSE 日志", () => removeOutputPath(path.join(generateDir, "opencode-sse.jsonl")));
    await attempt("删除轮询日志", () => removeOutputPath(path.join(generateDir, "opencode-polling.jsonl")));
  }
  if (pruneTransientArtifacts && projectDir) {
    await attempt("清理 Agent 临时产物", () => pruneGeneratedArtifacts(projectDir));
  }
  if (pruneProject && projectDir) {
    await attempt("清理工程构建缓存", () => pruneGeneratedProjectDirs(projectDir));
  }
  if (failures.length) {
    await fs.appendFile(
      path.join(generateDir || projectDir || AUTORUN_ROOT, "cleanup-errors.log"),
      `${caseName}: ${failures.join("；")}\n`,
      "utf8",
    ).catch(() => {});
  }
}

async function runCase({
  caseInfo,
  batchRoot,
  client,
  model,
  execution,
  skillRuntime,
  ohosTestEnabled,
  cloudTestEnabled,
  preserveForWhitebox,
  store,
  reporter,
  signal,
}) {
  const caseName = caseInfo.name;
  const caseRunDir = path.join(batchRoot, safeName(caseName));
  const originalDir = path.join(caseRunDir, "original");
  // 保留源用例的工程目录名（base 或 task），使输出工程与 metadata.base_project 一致。
  const projectDir = path.join(caseRunDir, caseInfo.projectName);
  const generateDir = path.join(caseRunDir, "generate");
  const patchPath = path.join(caseRunDir, "diff", "changes.patch");
  const resultPath = path.join(caseRunDir, "result.json");
  const statePath = path.join(caseRunDir, "state.json");
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
    await copyProject(caseInfo.projectDir, originalDir);
    await copyProject(originalDir, projectDir);
    const installedSkill = await installProjectSkill({ runtime: skillRuntime, projectDir, signal });
    await atomicWriteJson(path.join(generateDir, "skill-runtime.json"), {
      ...summarizeAgentSkillRuntime(skillRuntime),
      installedSkill,
    });
    if (installedSkill) await writeAgentConsole("skill_prepared", `${installedSkill.name} 已预装到 ${installedSkill.root}`);
    // 用户消息保持为用例 PROMPT.md 原文；无人值守等运行策略由 Agent 会话配置承载。
    const prompt = sourcePrompt;
    await fs.writeFile(path.join(generateDir, "input.txt"), prompt, "utf8");
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
    let lastInteractionErrorAt = 0;
    let lastQuotaNotifiedAt = 0;
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
        if (event === "permission_replied") {
          writeAgentConsole("interaction", `已自动允许 permission；permission=${data.permission || "unknown"}；requestId=${data.requestId}`).catch(() => {});
        } else if (event === "question_replied") {
          writeAgentConsole("interaction", `已自动回答 question；requestId=${data.requestId}；answers=${JSON.stringify(data.answers || [])}`).catch(() => {});
        } else if (event === "interaction_error" && Date.now() - lastInteractionErrorAt > 5000) {
          lastInteractionErrorAt = Date.now();
          writeAgentConsole("interaction-error", `${data.kind || "interaction"} 自动处理失败，将继续重试：${data.error || "unknown error"}`).catch(() => {});
        }
      },
      onQuotaExceeded: (message, hard) => {
        if (Date.now() - lastQuotaNotifiedAt > 5000) {
          lastQuotaNotifiedAt = Date.now();
          const action = hard ? "用量上限，停止用例" : "限流，等待恢复";
          reporter.caseProgress(caseName, `检测到 API ${action}：${message}`);
          writeAgentConsole("quota", message).catch(() => {});
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
    const skillWorkflow = await inspectSkillWorkflow({ runtime: skillRuntime, projectDir, signal });
    if (skillWorkflow) {
      await atomicWriteJson(path.join(generateDir, "skill-workflow.json"), skillWorkflow);
      await writeAgentConsole("skill_workflow", `Skill 账本/状态/报告检查：${skillWorkflow.status}`);
      if (skillWorkflow.status !== "validated") {
        reporter.caseProgress(caseName, "Skill 流程产物不完整，已记录 skill-workflow.json；继续独立测试与评价");
      }
    }
    await generatePatch(projectDir, baseline, patchPath);
    await cleanupCaseArtifacts({
      caseName,
      originalDir,
      projectDir,
      patchPath,
      generateDir,
      removeRawAgentLogs: true,
      pruneTransientArtifacts: true,
      pruneProject: !ohosTestEnabled,
      keepOriginal: preserveForWhitebox,
    });

    const agentFinishedAt = new Date();
    const agentElapsedSec = Math.round((agentFinishedAt.getTime() - startedAt.getTime()) / 1000);
    const pendingStages = ohosTestEnabled || cloudTestEnabled || preserveForWhitebox;
    const result = {
      case: caseName,
      status: pendingStages ? "running" : "completed",
      agentStatus: "completed",
      quotaLimited: monitored.quotaLimited || false,
      sessionId,
      childSessionIds: monitored.childSessionIds,
      agent: execution.agent,
      providerId: model.providerId,
      modelId: model.modelId,
      startedAt: startedAt.toISOString(),
      agentFinishedAt: agentFinishedAt.toISOString(),
      agentElapsedSec,
      ...(!pendingStages ? { finishedAt: agentFinishedAt.toISOString(), elapsedSec: agentElapsedSec } : {}),
      finishReason: monitored.finishReason,
      tokenUsage,
      agentCompile,
      agentCompileAttempts: agentLogs.agentCompileAttempts,
      ...(skillWorkflow ? { skillWorkflow } : {}),
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
        consolePath: agentConsolePath,
      },
      ...(ohosTestEnabled ? { ohosTest: { status: "queued" } } : {}),
      ...(cloudTestEnabled ? { cloudTest: { status: "queued" } } : {}),
      ...(preserveForWhitebox ? { whitebox: { status: "queued" } } : {}),
    };
    const finalPreview = compactPreview(monitored.output, 500);
    if (finalPreview) await writeAgentConsole("final", finalPreview);
    await writeAgentConsole("complete", `执行完成；完整输出=${agentLogs.transcriptPath}`);
    await agentConsoleWriteChain;
    await atomicWriteJson(resultPath, result);
    if (pendingStages) {
      await updateState({
        status: "running",
        stage: ohosTestEnabled ? "ohostest_queued" : cloudTestEnabled ? "cloudtest_queued" : "whitebox_queued",
        agentStatus: "completed",
        agentFinishedAt: result.agentFinishedAt,
        resultPath,
        patchPath,
        tokenUsage,
        agentCompile,
        ...(ohosTestEnabled ? { ohosTest: result.ohosTest } : {}),
        ...(cloudTestEnabled ? { cloudTest: result.cloudTest } : {}),
        ...(preserveForWhitebox ? { whitebox: result.whitebox } : {}),
      });
      if (ohosTestEnabled) reporter.caseOhosTestQueued(caseName, { agentTimedOut: false });
    } else {
      await updateState({ status: "completed", stage: "completed", finishedAt: result.finishedAt, resultPath, patchPath, tokenUsage, agentCompile });
      reporter.caseFinished(result);
    }
    return result;
  } catch (error) {
    if (baseline && await exists(projectDir)) {
      await generatePatch(projectDir, baseline, patchPath).catch(() => {});
    }
    await cleanupCaseArtifacts({
      caseName,
      originalDir,
      projectDir,
      patchPath,
      keepOriginal: preserveForWhitebox,
      pruneTransientArtifacts: true,
    });
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
    // 限额优先于超时：限流重试期间没有消息活动，会先触发 idle 超时，
    // 但根因是 API 限额，应显示 rate_limited 而不是 timed_out。
    const rateLimited = Boolean(error.quotaLimited)
      || isQuotaExceededMessage(error.message)
      || await sseLogIndicatesQuota(path.join(generateDir, "opencode-sse.jsonl"));
    const status = interrupted ? "interrupted" : rateLimited ? "rate_limited" : timedOut ? "timed_out" : "failed";
    const result = {
      case: caseName,
      status,
      agentStatus: status,
      agentError: error.message,
      quotaLimited: rateLimited,
      sessionId: error.sessionId || sessionId,
      childSessionIds: error.childSessionIds || [],
      error: error.message,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      elapsedSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
      tokenUsage,
      agentCompile,
      agentCompileAttempts: agentLogs?.agentCompileAttempts || [],
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
        consolePath: agentConsolePath,
      },
    };
    await writeAgentConsole(status, error.message).catch(() => {});
    await agentConsoleWriteChain.catch(() => {});
    await atomicWriteJson(resultPath, result);
    await updateState({ status, stage: status, error: error.message, finishedAt: result.finishedAt, resultPath, tokenUsage, agentCompile });
    if (!preserveForWhitebox) reporter.caseFinished(result);
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

async function prepareReusedAgentResult({ caseInfo, batchRoot, previousResult, sourceBatchId, preserveForWhitebox, store }) {
  if (!await exists(previousResult.projectDir)) {
    throw new Error(`历史 Agent 工程不存在，无法仅重试 ohosTest: ${previousResult.projectDir}`);
  }
  if (!await exists(previousResult.patchPath)) {
    throw new Error(`历史 Agent patch 不存在，无法仅重试 ohosTest: ${previousResult.patchPath}`);
  }

  const caseRunDir = path.join(batchRoot, safeName(caseInfo.name));
  const projectDir = path.join(caseRunDir, caseInfo.projectName);
  const originalDir = path.join(caseRunDir, "original");
  const generateDir = path.join(caseRunDir, "generate");
  const diffDir = path.join(caseRunDir, "diff");
  const patchPath = path.join(diffDir, "changes.patch");
  const resultPath = path.join(caseRunDir, "result.json");
  const statePath = path.join(caseRunDir, "state.json");
  const startedAt = new Date().toISOString();

  await fs.mkdir(generateDir, { recursive: true });
  await fs.mkdir(diffDir, { recursive: true });
  if (preserveForWhitebox) await copyProject(caseInfo.projectDir, originalDir);
  await copyProject(previousResult.projectDir, projectDir);
  await pruneGeneratedArtifacts(projectDir);
  const previousPatch = await fs.readFile(previousResult.patchPath, "utf8");
  await fs.writeFile(patchPath, filterGeneratedArtifactPatch(previousPatch), "utf8");

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
    agentCompile: previousResult.agentCompile || emptyCompileUsage(),
    agentCompileAttempts: Array.isArray(previousResult.agentCompileAttempts)
      ? previousResult.agentCompileAttempts
      : [],
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
      compileAttemptsPath: previousResult.logs?.compileAttemptsPath || "",
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

async function executeOhosTestForCase({
  caseInfo,
  agentResult,
  settings,
  deviceLeasePath,
  deferProjectCleanup = false,
  deferFinish = false,
  store,
  reporter,
  signal,
}) {
  const caseName = caseInfo.name;
  const caseRunDir = path.dirname(agentResult.resultPath);
  const statePath = path.join(caseRunDir, "state.json");
  const startedAt = new Date().toISOString();
  reporter.caseOhosTestStarted(caseName);
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
      runMode: settings.runMode,
      startedAt,
      finishedAt: new Date().toISOString(),
      elapsedSec: elapsedSeconds(startedAt, new Date().toISOString()),
      error: error.message,
      outputDir: path.join(caseRunDir, ".ohostest-runs"),
      resultPath: "",
      summaryPath: "",
    };
  }

  // ohosTest 与云测试等分支相互独立，结束时立即定格“测试状态”列；
  // deferFinish 时最终 caseFinished 仍会随全部分支汇总统一收尾。
  reporter.caseOhosTestFinished(caseName, ohosTest);

  const retainedOhosTestWorkDir = ohosTest.workDir
    || (await exists(path.join(caseRunDir, "ohostest-workdir"))
      ? path.join(caseRunDir, "ohostest-workdir")
      : await exists(path.join(caseRunDir, "work"))
        ? path.join(caseRunDir, "work")
        : "");
  await cleanupCaseArtifacts({
    caseName,
    projectDir: agentResult.projectDir,
    pruneProject: !deferProjectCleanup && (ohosTest.status === "completed" || Boolean(retainedOhosTestWorkDir)),
  });

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
    logs: { ...agentResult.logs },
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
  if (!deferFinish) reporter.caseFinished(finalResult);
  return finalResult;
}

// 云测试收尾：把云测试结果合并进用例 result.json，并完成状态/报告上报。
async function finalizeCloudTestCase({ caseInfo, caseResult, cloudResult, store, reporter, deferFinish = false }) {
  const caseName = caseInfo.name;
  const caseRunDir = path.dirname(caseResult.resultPath);
  const resultPath = caseResult.resultPath;
  const cloud = {
    status: cloudResult.status || "failed",
    taskGroupId: cloudResult.task?.taskGroupId || "",
    taskName: cloudResult.task?.taskName || "",
    error: cloudResult.error || "",
    outputDir: cloudResult.outputDir || "",
  };
  const current = await readJson(resultPath) || caseResult;
  // ohostest/agent 已失败的用例保持原状态；"running" 表示尚无后置阶段定级，
  // 视为此前阶段成功，最终状态由云测试结果决定
  const previousStatus = !current.status || current.status === "running" ? "completed" : current.status;
  const status = previousStatus !== "completed" ? previousStatus : (cloud.status === "completed" ? "completed" : cloud.status);
  const final = {
    ...current,
    status,
    error: status === "completed" ? "" : (current.error || cloud.error || `云测试 ${cloud.status}`),
    cloudTest: cloud,
    finishedAt: new Date().toISOString(),
  };
  final.elapsedSec = elapsedSeconds(final.startedAt, final.finishedAt);
  await atomicWriteJson(resultPath, final);
  const statePath = path.join(caseRunDir, "state.json");
  const stateCurrent = await readJson(statePath) || { case: caseName };
  await atomicWriteJson(statePath, {
    ...stateCurrent,
    status,
    stage: status,
    error: final.error,
    finishedAt: final.finishedAt,
    cloudTest: cloud,
    updatedAt: new Date().toISOString(),
  });
  await store.setCase(caseName, { status, stage: status, error: final.error, finishedAt: final.finishedAt, cloudTest: cloud });
  if (!deferFinish) reporter.caseFinished(final);
  return final;
}

async function validateServerConfig(client, execution, loadedConfig, sourceMode, signal) {
  const config = loadedConfig || await client.getConfig(120);
  const usesBuiltInAgent = sourceMode === OPENCODE_SOURCE_MODES.SOFTWARE_ENGINEERING;
  if (usesBuiltInAgent && !serverAllowsExecution(config, execution.agent)) {
    throw new Error(`OpenCode Server 未对 Agent ${execution.agent} 启用运行权限（Skill 来源白名单除外）`);
  }
  if (!usesBuiltInAgent && !Object.hasOwn(config?.agent || {}, execution.agent)) {
    throw new Error(`Server 未配置 Agent: ${execution.agent}`);
  }
  // Software Engineering 使用 Autorun 配置副本，必须在启动前注入无人值守
  // 权限。HarmonyBot 配置完全由插件管理，运行中的 question/permission
  // 请求由 session monitor 自动回复，不修改插件配置或 Bundle。
  if (usesBuiltInAgent && !hasAgentSessionPolicy(config, execution.agent)) {
    throw new Error(`OpenCode Server 未为 Agent ${execution.agent} 注入无人值守会话策略`);
  }
  if (execution.agent === "harmonyos-multi-device") {
    const agentPrompt = String(config.agent[execution.agent]?.prompt || "");
    if (!agentPrompt.includes("harmonyos-ui-multi")) {
      throw new Error("harmonyos-multi-device 插件未正确加载：运行时 Agent prompt 缺少一多适配工作流指令");
    }
    const skills = await waitForSkills(client, execution.casesRoot, { signal });
    const skillNames = new Set((Array.isArray(skills) ? skills : []).map((item) => String(item?.name || item?.id || "")));
    for (const required of ["harmonyos-ui-multi"]) {
      if (!skillNames.has(required)) {
        throw new Error(`harmonyos-multi-device 关键 Skill 未注册: ${required}`);
      }
    }
  }
  return resolveConfiguredModel({
    client,
    config,
    providerId: String(execution.providerId || "").trim(),
    modelId: execution.model,
    directory: execution.casesRoot,
    signal,
  });
}

async function runBatch(config, client, serverConfig, checkOnly = false, {
  signal,
  skillRuntime,
  retryPlan,
  runId = "",
  targetRoot = "",
  targetId = "",
  environmentFailures = [],
  onEnvironmentReady,
} = {}) {
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
  // 云测试默认属于主流程；配置不完整时告警并跳过（不阻断批次），enabled=false 可显式关闭
  let cloudTest = { enabled: false, settings: null };
  try {
    const cloudSettings = loadCloudTestConfig(config);
    cloudTest = { enabled: cloudSettings.enabled, settings: cloudSettings };
  } catch (error) {
    if (config.cloudTest?.enabled !== false) {
      environmentFailures.push(`云测试：${error.message}`);
    }
  }
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
  const whiteboxConfig = config.whiteboxEvaluation;
  let whiteboxOrchestrator;
  if (whiteboxConfig.enabled) {
    const whiteboxSource = await resolveOpenCodeSource({
      mode: whiteboxConfig.runtime.source,
      root: whiteboxConfig.runtime.root,
    });
    whiteboxOrchestrator = await createWhiteboxOrchestrator({
      config: whiteboxConfig,
      serverConfig,
      generationModel: model,
      opencodeBinPath: whiteboxSource.opencodeBinPath,
      repoRoot: AUTORUN_ROOT,
      signal,
    });
  }
  throwIfInterrupted(signal);
  onEnvironmentReady?.({
    agent: execution.agent,
    providerId: model.providerId,
    modelId: model.modelId,
  });
  if (checkOnly) return { checked: true, caseCount: cases.length, skippedCases, ohosTest, whiteboxEvaluation: whiteboxConfig };

  // Agent 来源分类仍用于报告展示；目录层级由一次运行的共享 runId 和 targetId 决定。
  const modeDirectoryName = await resolveBatchModeDirectoryName(config.server.opencodeSource);
  const id = runId || batchId();
  const resolvedTargetId = safeName(targetId || config.server.opencodeSource.id || modeDirectoryName);
  const batchRoot = targetRoot || path.join(execution.outputRoot, id, resolvedTargetId);
  await fs.mkdir(batchRoot, { recursive: true });
  const state = {
    batchId: id,
    targetId: resolvedTargetId,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    agent: execution.agent,
    // Agent 来源分类（harmonyBot=自研 / softwareEngineering=软工 / baseModel=裸模），供报告展示
    opencodeSourceMode: modeDirectoryName,
    providerId: model.providerId,
    modelId: model.modelId,
    concurrency: execution.concurrency,
    ohosTest: {
      enabled: ohosTest.enabled,
      concurrency: ohosTest.enabled ? 1 : 0,
    },
    cloudTest: {
      enabled: cloudTest.enabled,
      testCategories: cloudTest.enabled ? cloudTest.settings.testCategories : [],
    },
    whiteboxEvaluation: {
      enabled: whiteboxConfig.enabled,
      concurrency: whiteboxConfig.enabled ? whiteboxConfig.concurrency : 0,
      judge: whiteboxOrchestrator?.judge,
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
  // 批次存活标记：恢复扫描据此跳过仍在运行的批次（进程退出后残留的 pid 文件在恢复时按死进程处理）
  await fs.writeFile(path.join(batchRoot, "batch.pid"), `${process.pid}\n`, "utf8");
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
  const postValidationJobs = [];
  const whiteboxJobsByCase = new Map();
  let ohosTestTail = Promise.resolve();
  let cloudSubmitTail = Promise.resolve();
  let stopQueue = false;

  function startWhiteboxBranch(caseInfo, agentResult) {
    if (!whiteboxOrchestrator || !agentResult?.projectDir) {
      return Promise.resolve(null);
    }
    const job = (async () => {
      try {
        const prepared = await prepareWhiteboxInput({
          batchId: id,
          caseInfo,
          agentResult,
          execution,
          config: whiteboxConfig,
        });
        await store.setCase(caseInfo.name, {
          whitebox: { status: "queued", inputPath: prepared.inputPath, outputDir: prepared.outputDir },
        });
        const summary = await whiteboxOrchestrator.schedule(prepared);
        const value = { ...summary, judge: whiteboxOrchestrator.judge };
        await store.setCase(caseInfo.name, { whitebox: value }).catch(() => {});
        return { case: caseInfo.name, ...value };
      } catch (error) {
        const failed = {
          case: caseInfo.name,
          status: "failed",
          error: error.message,
          judge: whiteboxOrchestrator.judge,
        };
        await store.setCase(caseInfo.name, { whitebox: failed }).catch(() => {});
        return failed;
      }
    })();
    whiteboxJobsByCase.set(caseInfo.name, job);
    return job;
  }

  // 云测试分支：远端执行，不占用本地设备。提交阶段（构建+上传+提交）跨用例串行
  // （规避频率限制与并发构建），轮询阶段各任务并行；返回云测试结果（不 reject）。
  function startCloudBranch(caseInfo, agentResult) {
    const caseName = caseInfo.name;
    const caseRunDir = path.dirname(agentResult.resultPath);
    const outDir = path.join(caseRunDir, "cloudtest");
    // 云测试进度走专用报告通道（云测试列 + 当前活动），不污染 Agent 阶段状态
    const onLog = (message) => reporter.caseCloudTestProgress(caseName, `云测试：${message}`);
    const fallback = (error) => error.cloudResult || { status: "failed", error: error.message, outputDir: outDir };
    const submitted = cloudSubmitTail.then(() => submitCloudTestForProject({
      config,
      settings: cloudTest.settings,
      projectDir: agentResult.projectDir,
      caseName,
      // 任务名默认为 工程名(用例名)_时间戳
      taskNameLabel: caseName,
      outDir,
      signal,
      onLog,
    }));
    cloudSubmitTail = submitted.catch(() => {});
    const outcome = submitted.then(
      (ctx) => finishCloudTestPolling({ ...ctx, signal, onLog }).then(
        (cloudResult) => cloudResult,
        (error) => fallback(error),
      ),
      (error) => fallback(error),
    );
    // 云测试列独立定格：分支出结果立即上报，不等 ohosTest/白盒汇总
    return outcome.then((cloudResult) => {
      reporter.caseCloudTestFinished(caseName, cloudResult);
      return cloudResult;
    });
  }

  // ohosTest 分支：本地模拟器，跨用例串行（设备租约）；返回用例级最终结果（不 reject）。
  function startOhosBranch(caseInfo, agentResult) {
    const scheduled = ohosTestTail.then(() => executeOhosTestForCase({
      caseInfo,
      agentResult,
      settings: ohosTest,
      deviceLeasePath: path.join(batchRoot, ".device-validation.lock"),
      deferProjectCleanup: whiteboxConfig.enabled,
      store,
      reporter,
      signal,
      // 最终 caseFinished 上报统一由 schedulePostValidation 的 join 完成
      deferFinish: true,
    }));
    // 只有这一条 Promise 链会进入 Runner，确保模拟器启动和设备执行始终串行。
    ohosTestTail = scheduled.catch(() => {});
    return scheduled.then(
      (finalResult) => finalResult,
      async (error) => {
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
        reporter.caseOhosTestFinished(caseInfo.name, failed.ohosTest);
        return failed;
      },
    );
  }

  // Agent 完成后：白盒评价、云测试（远端）与 ohosTest（本地设备）并行执行。
  // 三个分支互不依赖，全部结束后再合并结果、清理工程并统一上报。
  function schedulePostValidation(caseInfo, agentResult, options = {}) {
    const runCloud = options.runCloud ?? cloudTest.enabled;
    const runOhos = options.runOhos ?? ohosTest.enabled;
    const runWhitebox = options.runWhitebox ?? whiteboxConfig.enabled;
    if (!runCloud && !runOhos && !runWhitebox) {
      results.push(agentResult);
      return;
    }
    if (runCloud) reporter.caseCloudTestQueued(caseInfo.name);
    const cloudBranch = runCloud ? startCloudBranch(caseInfo, agentResult) : Promise.resolve(null);
    const ohosBranch = runOhos ? startOhosBranch(caseInfo, agentResult) : Promise.resolve(null);
    const whiteboxBranch = runWhitebox ? startWhiteboxBranch(caseInfo, agentResult) : Promise.resolve(null);
    const job = Promise.all([cloudBranch, ohosBranch, whiteboxBranch]).then(async ([cloudOutcome, ohosOutcome, whiteboxOutcome]) => {
      let merged = ohosOutcome || agentResult;
      if (cloudOutcome) {
        merged = await finalizeCloudTestCase({
          caseInfo,
          caseResult: ohosOutcome || agentResult,
          cloudResult: cloudOutcome,
          store,
          reporter,
          deferFinish: true,
        });
      }
      if (whiteboxOutcome) merged = { ...merged, whitebox: whiteboxOutcome };
      const finishedAt = new Date().toISOString();
      const status = merged.status === "running" ? "completed" : merged.status;
      merged = {
        ...merged,
        status,
        error: status === "completed" ? "" : merged.error || "",
        finishedAt,
        elapsedSec: elapsedSeconds(merged.startedAt, finishedAt),
      };
      if (merged.resultPath) await atomicWriteJson(merged.resultPath, merged).catch(() => {});
      if (merged.resultPath) {
        const statePath = path.join(path.dirname(merged.resultPath), "state.json");
        const currentState = await readJson(statePath) || { case: merged.case };
        await atomicWriteJson(statePath, {
          ...currentState,
          status,
          stage: status,
          error: merged.error,
          finishedAt,
          ...(whiteboxOutcome ? { whitebox: whiteboxOutcome } : {}),
          updatedAt: finishedAt,
        }).catch(() => {});
      }
      await store.setCase(caseInfo.name, {
        status,
        stage: status,
        error: merged.error,
        finishedAt,
        ...(whiteboxOutcome ? { whitebox: whiteboxOutcome } : {}),
      }).catch(() => {});
      if (runWhitebox && merged.resultPath) {
        const caseDir = path.dirname(merged.resultPath);
        await cleanupCaseArtifacts({
          caseName: merged.case,
          originalDir: path.join(caseDir, "original"),
          projectDir: merged.projectDir,
          patchPath: merged.patchPath,
          pruneProject: true,
        });
      }
      reporter.caseFinished(merged);
      results.push(merged);
      if (merged.status !== "completed" && !execution.continueOnError) stopQueue = true;
    }).catch(async (error) => {
      const finishedAt = new Date().toISOString();
      const failed = {
        ...agentResult,
        status: signal?.aborted ? "interrupted" : "failed",
        error: `后置评价/测试编排异常: ${error.message}`,
        finishedAt,
        elapsedSec: elapsedSeconds(agentResult.startedAt, finishedAt),
      };
      if (failed.resultPath) await atomicWriteJson(failed.resultPath, failed).catch(() => {});
      await store.setCase(caseInfo.name, {
        status: failed.status,
        stage: failed.status,
        error: failed.error,
        finishedAt,
      }).catch(() => {});
      reporter.caseFinished(failed);
      results.push(failed);
      if (!execution.continueOnError) stopQueue = true;
    });
    postValidationJobs.push(job);
  }

  async function worker(workerIndex) {
    while (!stopQueue && !signal?.aborted) {
      const next = queue.shift();
      if (!next) return;
      reporter.caseStarted(next.name, workerIndex);
      try {
        const previousResult = retryPlan?.previousResults.get(next.name);
        if (await canReuseSuccessfulAgent(previousResult, next)) {
          if (!ohosTest.enabled && !cloudTest.enabled && !whiteboxConfig.enabled) {
            throw new Error(`用例 ${next.name} 的 Agent 已成功，但 ohosTest、cloudTest 和 whiteboxEvaluation 均未启用`);
          }
          const agentResult = await prepareReusedAgentResult({
            caseInfo: next,
            batchRoot,
            previousResult,
            sourceBatchId: retryPlan.sourceBatchId,
            preserveForWhitebox: whiteboxConfig.enabled,
            store,
          });
          if (ohosTest.enabled) reporter.caseOhosTestQueued(next.name);
          schedulePostValidation(next, agentResult);
          continue;
        }
        const agentResult = await runCase({
          caseInfo: next,
          batchRoot,
          client,
          model,
          execution,
          skillRuntime,
          ohosTestEnabled: ohosTest.enabled,
          cloudTestEnabled: cloudTest.enabled,
          preserveForWhitebox: whiteboxConfig.enabled,
          store,
          reporter,
          signal,
        });
        schedulePostValidation(next, agentResult);
      } catch (error) {
        const agentResult = error.caseResult || { case: next.name, status: "failed", error: error.message };
        // Agent 空闲/总时长超时不代表已生成工程不能编译。此时仍把现有 base/ 或 task/
        // 交给设备验证队列（云测试与 ohosTest 并行）；用户中断时不再启动新的任务。
        const shouldValidateAfterAgentTimeout = (
          (ohosTest.enabled || cloudTest.enabled)
          && !signal?.aborted
          && agentResult.status === "timed_out"
          && agentResult.agentStatus === "timed_out"
        );
        if (shouldValidateAfterAgentTimeout || (whiteboxConfig.enabled && !signal?.aborted)) {
          if (shouldValidateAfterAgentTimeout && ohosTest.enabled) {
            reporter.caseOhosTestQueued(next.name, { agentTimedOut: true });
          }
          schedulePostValidation(next, agentResult, {
            runCloud: shouldValidateAfterAgentTimeout && cloudTest.enabled,
            runOhos: shouldValidateAfterAgentTimeout && ohosTest.enabled,
            runWhitebox: whiteboxConfig.enabled,
          });
          if (!execution.continueOnError) stopQueue = true;
        } else {
          results.push(agentResult);
          if (whiteboxConfig.enabled) reporter.caseFinished(agentResult);
          if (signal?.aborted || !execution.continueOnError) stopQueue = true;
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: workerCount }, (_, index) => worker(index + 1)),
  );
  await Promise.all(postValidationJobs);
  const whiteboxResults = whiteboxOrchestrator
    ? await Promise.all([...whiteboxJobsByCase.values()])
    : [];

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
    targetId: resolvedTargetId,
    status: interrupted ? "interrupted" : failedCount ? "completed_with_failures" : "completed",
    finishedAt: new Date().toISOString(),
    agent: execution.agent,
    opencodeSourceMode: modeDirectoryName,
    providerId: model.providerId,
    modelId: model.modelId,
    total: cases.length,
    completed: results.filter((item) => item.status === "completed").length,
    failed: failedCount,
    skipped: skippedCases.map((item) => ({ case: item.name, reason: item.skipReason })),
    tokenUsage,
    agentCompile,
    // 供批次/合并报告判断云测试章节空态（启用但零数据时渲染「暂无云测试数据」）
    cloudTest: {
      enabled: cloudTest.enabled,
    },
    whiteboxEvaluation: {
      enabled: whiteboxConfig.enabled,
      judge: whiteboxOrchestrator?.judge,
      completed: whiteboxResults.filter((item) => item.status === "completed").length,
      failed: whiteboxResults.filter((item) => item.status !== "completed").length,
    },
    results,
    ...(retryPlan ? {
      retry: {
        sourceBatchId: retryPlan.sourceBatchId,
        requestedCaseName: retryPlan.requestedCaseName,
      },
    } : {}),
  };
  try {
    summary.reports = await writeBatchReport({
      batchRoot,
      summary,
      uploadConfig: config.upload,
      onLog: silentLog,
    });
  } catch (error) {
    summary.reportError = error.message;
  }
  await atomicWriteJson(path.join(batchRoot, "summary.json"), summary);
  await store.setBatch({ status: summary.status, finishedAt: summary.finishedAt });
  // 批次已结束，移除存活标记（残留的 pid 文件在恢复扫描时按死进程处理）
  await fs.rm(path.join(batchRoot, "batch.pid"), { force: true }).catch(() => {});
  reporter.finish(summary);
  if (activeReporter === reporter) activeReporter = null;
  return summary;
}

const args = parseArgs(process.argv.slice(2));
const config = await loadAutorunConfig(args.configPath);

// --merge 模式：仅合并既有批次报告，不启动 OpenCode Server、不跑用例，短路退出。
if (args.merge !== undefined) {
  const mergeRoot = args.merge || config.execution.outputRoot;
  try {
    const merged = await mergeOverview({ root: mergeRoot });
    console.log(`[merge] 已合并 ${merged.batchCount} 个批次 → ${merged.overviewPath}`);
    process.exit(0);
  } catch (error) {
    console.error(`[merge] ${error.message}`);
    process.exit(1);
  }
}

// --cloud-test 模式：本地构建签名包 → 上传 AGC 云测试 → 提交任务 → 轮询结果，短路退出。
// TODO(用户要求保留调试)：云测试已接入主批次流程（cloudTest.enabled 默认 true），
// 此独立指令仅作调试用途，待确认稳定后删除（连同 --poll-task 一并评估）。
if (args.cloudTest) {
  const { runCloudTest } = await import("./src/cloudtest/cloudtest-orchestrator.mjs");
  let projectDir = args.cloudProjectDir ? path.resolve(args.cloudProjectDir) : "";
  if (args.retryCaseName) {
    const caseRoot = path.join(config.execution.casesRoot, args.retryCaseName);
    if (!await exists(caseRoot)) {
      console.error(`[cloudtest] 用例不存在: ${caseRoot}（casesRoot=${config.execution.casesRoot}）`);
      process.exit(1);
    }
    const projectName = args.cloudProjectName
      || (await exists(path.join(caseRoot, "base")) ? "base" : "task");
    const candidate = path.join(caseRoot, projectName);
    if (!await exists(candidate)) {
      console.error(`[cloudtest] 用例工程目录不存在: ${candidate}`);
      process.exit(1);
    }
    projectDir = candidate;
  }

  const cloudShutdown = new AbortController();
  const onCloudInterrupt = (signame) => {
    if (cloudShutdown.signal.aborted) return;
    console.error(`[cloudtest] ${signame}，正在收尾云测试`);
    cloudShutdown.abort(new Error(`云测试执行被中断（${signame}）`));
  };
  process.once("SIGINT", () => onCloudInterrupt("收到 SIGINT（Ctrl+C）"));
  process.once("SIGTERM", () => onCloudInterrupt("收到 SIGTERM"));

  let cloudExitCode = 0;
  try {
    const cloudResult = await runCloudTest({
      config,
      projectDir,
      appPath: args.appPath,
      caseName: args.retryCaseName,
      taskName: args.taskName,
      signal: cloudShutdown.signal,
      onLog: (message) => console.log(`[cloudtest] ${message}`),
    });
    if (cloudResult.status !== "completed") cloudExitCode = 1;
  } catch (error) {
    console.error(`[cloudtest] ${error.stack || error.message}`);
    cloudExitCode = 1;
  }
  process.exit(cloudExitCode);
}

// --poll-task 模式：不构建、不提交，仅续查已提交云测试任务的状态，短路退出。
if (args.pollTask) {
  const { pollExistingTask } = await import("./src/cloudtest/cloudtest-orchestrator.mjs");
  const pollShutdown = new AbortController();
  const onPollInterrupt = (signame) => {
    if (pollShutdown.signal.aborted) return;
    console.error(`[cloudtest] ${signame}，正在收尾轮询`);
    pollShutdown.abort(new Error(`云测试轮询被中断（${signame}）`));
  };
  process.once("SIGINT", () => onPollInterrupt("收到 SIGINT（Ctrl+C）"));
  process.once("SIGTERM", () => onPollInterrupt("收到 SIGTERM"));
  let pollExitCode = 0;
  try {
    const pollResult = await pollExistingTask({
      config,
      taskGroupId: args.pollTask,
      signal: pollShutdown.signal,
      onLog: (message) => console.log(`[cloudtest] ${message}`),
    });
    if (pollResult.status !== "completed") pollExitCode = 1;
  } catch (error) {
    console.error(`[cloudtest] ${error.stack || error.message}`);
    pollExitCode = 1;
  }
  process.exit(pollExitCode);
}

const shutdownController = new AbortController();
let server;
let retryPlan;
let exitCode = 0;
let serverStopping = false;
let batchSettled = false;
let serverStopPromise;
let shutdownFallbackTimer;
let forceStopOwnedServer = false;
const environmentFailures = [];
const printedStartupTargets = new Set();
let currentTarget;

function targetRunConfiguration(target, override = {}) {
  return {
    agent: override.agent || (target?.mode === OPENCODE_SOURCE_MODES.SOFTWARE_ENGINEERING
      ? "build"
      : target?.agent || config.execution.agent),
    providerId: override.providerId || config.execution.generationModel.providerId,
    modelId: override.modelId || config.execution.generationModel.modelId,
  };
}

function printTargetStartup(target, override = {}) {
  const targetKey = target?.id || "default";
  if (printedStartupTargets.has(targetKey)) return;
  writeAutorunStartupSummary({
    failures: environmentFailures,
    ...targetRunConfiguration(target, override),
  });
  printedStartupTargets.add(targetKey);
}

function beginOwnedServerStop() {
  if (!server?.owned || (config.server.stopWhenFinished === false && !forceStopOwnedServer)) {
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
  shutdownController.abort(error);
  shutdownFallbackTimer = setTimeout(() => {
    void beginOwnedServerStop();
  }, 10_000);
  exitCode = 1;
}

const onSigint = () => {
  if (shutdownController.signal.aborted) return;
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
  const devecoCli = await detectDevEcoCli();
  if (!devecoCli.installed) {
    environmentFailures.push(`DevEco CLI：${formatDevEcoCliFailure(devecoCli)}`);
  }
  await recoverInterruptedRuns(config.execution.outputRoot);
  if (args.retryBatchId) {
    if (config.server.opencodeTargets.multiple) {
      throw new Error("多 Agent 对比暂不支持 --retry；请使用单 Agent 配置重试指定目标");
    }
    retryPlan = await loadRetryPlan(config.execution.outputRoot, args.retryBatchId, args.retryCaseName);
  }
  const targetPlan = config.server.opencodeTargets;
  const allocated = args.checkOnly
    ? { runId: `${batchId()}-check`, runRoot: "" }
    : await allocateRunDirectory(config.execution.outputRoot);
  if (targetPlan.multiple) {
    config.server.providerOverlayPath = await prepareSharedGenerationProvider(config, allocated.runId);
  }
  const casesRoot = targetPlan.multiple && !args.checkOnly
    ? await createSharedCasesSnapshot(config, allocated.runId, allocated.runRoot)
    : config.execution.casesRoot;
  const targetResults = [];
  forceStopOwnedServer = true;

  // 对比运行必须在任何 Agent Session 创建前确认所有来源都提供完全一致的
  // Provider/模型配置。预检严格串行且每次立即关闭 Server，避免后一个目标
  // 到运行阶段才暴露模型缺失，导致前一个目标已经消耗配额却无法形成有效对比。
  if (targetPlan.multiple && !args.checkOnly) {
    const fingerprints = [];
    for (const target of targetPlan.targets) {
      currentTarget = target;
      const targetRoot = path.join(allocated.runRoot, safeName(target.id));
      await fs.mkdir(targetRoot, { recursive: true });
      const prepared = configForTarget(config, target, allocated.runId, casesRoot, "preflight");
      const workspace = path.join(prepared.runtimeRoot, "workspace");
      await fs.mkdir(workspace, { recursive: true });
      let preflightServer;
      try {
        preflightServer = await ensureOpenCodeServer(prepared.config, {
          signal: shutdownController.signal,
          reuseExisting: false,
          workspace,
          isolateConfig: true,
        });
        server = preflightServer;
        const model = await validateServerConfig(
          preflightServer.client,
          prepared.config.execution,
          preflightServer.serverConfig,
          target.mode,
          shutdownController.signal,
        );
        const environment = await writeTargetEnvironmentManifest({
          targetRoot,
          target,
          targetConfig: prepared.config,
          source: preflightServer.source,
          server: preflightServer,
          model,
          signal: shutdownController.signal,
          environmentFailures,
        });
        fingerprints.push(environment.generationModel.configFingerprint);
      } catch (error) {
        await atomicWriteJson(path.join(targetRoot, "target-error.json"), {
          targetId: target.id,
          status: "preflight_failed",
          error: error.message,
          finishedAt: new Date().toISOString(),
        });
        environmentFailures.push(`${target.label || target.id}：${error.message}`);
        printTargetStartup(target);
        throw new Error(`Agent ${target.label} 预检失败: ${error.message}`, { cause: error });
      } finally {
        await stopOwnedServer(preflightServer).catch(silentLog);
        server = null;
      }
    }
    if (new Set(fingerprints).size !== 1) {
      throw new Error("多 Agent 的 Provider/模型配置指纹不一致，禁止开始对比执行");
    }
  }

  for (let index = 0; index < targetPlan.targets.length; index += 1) {
    const target = targetPlan.targets[index];
    currentTarget = target;
    if (shutdownController.signal.aborted) break;
    const targetRoot = args.checkOnly
      ? path.join(targetRuntimeRoot(config, allocated.runId, target.id), "check")
      : path.join(allocated.runRoot, safeName(target.id));
    await fs.mkdir(targetRoot, { recursive: true });
    const prepared = configForTarget(config, target, allocated.runId, casesRoot);
    const workspace = path.join(prepared.runtimeRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    server = null;
    serverStopping = false;
    serverStopPromise = undefined;
    batchSettled = false;
    try {
      server = await ensureOpenCodeServer(prepared.config, {
        signal: shutdownController.signal,
        reuseExisting: false,
        workspace,
        isolateConfig: true,
      });
      const watchedServer = server;
      if (server?.owned && server.child) {
        server.child.once("exit", (code, childSignal) => {
          if (serverStopping || batchSettled || server !== watchedServer) return;
          requestShutdown(`OpenCode Server 意外退出（code=${code ?? "null"}, signal=${childSignal || "none"}）`);
        });
        server.child.once("error", (error) => {
          if (serverStopping || batchSettled || server !== watchedServer) return;
          requestShutdown("OpenCode Server 子进程错误", error);
        });
      }
      // 在创建任何 Agent Session 前验证 Agent、模型和实际 Skill 清单；尤其是
      // 来源 skills 为空的目标，若发现全局/历史 Skill 泄漏会立即失败。
      const validatedModel = await validateServerConfig(
        server.client,
        prepared.config.execution,
        server.serverConfig,
        target.mode,
        shutdownController.signal,
      );
      await writeTargetEnvironmentManifest({
        targetRoot,
        target,
        targetConfig: prepared.config,
        source: server.source,
        server,
        model: validatedModel,
        signal: shutdownController.signal,
        environmentFailures,
      });
      const summary = await runBatch(prepared.config, server.client, server.serverConfig, args.checkOnly, {
        signal: shutdownController.signal,
        skillRuntime: server.skillRuntime,
        retryPlan,
        runId: allocated.runId,
        targetRoot,
        targetId: target.id,
        environmentFailures,
        onEnvironmentReady: (runConfiguration) => printTargetStartup(target, runConfiguration),
      });
      batchSettled = true;
      targetResults.push({ ...target, targetRoot, summary });
      if (!args.checkOnly && summary.failed) exitCode = 1;
    } catch (error) {
      batchSettled = true;
      activeReporter?.finishWithError(error.message);
      activeReporter = null;
      if (!printedStartupTargets.has(target.id)) {
        environmentFailures.push(`${target.label || target.id}：${error.message}`);
        printTargetStartup(target);
      }
      targetResults.push({ ...target, targetRoot, error: error.message });
      if (!args.checkOnly) {
        await atomicWriteJson(path.join(targetRoot, "target-error.json"), {
          targetId: target.id,
          status: "failed",
          error: error.message,
          finishedAt: new Date().toISOString(),
        });
      }
      exitCode = 1;
      if (shutdownController.signal.aborted) break;
    } finally {
      await beginOwnedServerStop();
      server = null;
      serverStopping = false;
      serverStopPromise = undefined;
    }
  }

  if (!args.checkOnly && allocated.runRoot) {
    for (const target of targetPlan.targets) {
      if (targetResults.some((item) => item.id === target.id)) continue;
      targetResults.push({
        ...target,
        targetRoot: path.join(allocated.runRoot, safeName(target.id)),
        error: shutdownController.signal.aborted ? "Autorun 已中断，目标未执行" : "前序目标失败，目标未执行",
      });
    }
    const configuredModel = config.execution.generationModel;
    const firstModel = targetResults.find((item) => item.summary)?.summary || {};
    const generationModel = {
      providerId: configuredModel.providerId || firstModel.providerId || "",
      modelId: configuredModel.modelId,
    };
    const report = await writeAgentComparisonReport({
      runRoot: allocated.runRoot,
      runId: allocated.runId,
      generationModel,
      targets: targetResults,
    });
    if (targetPlan.multiple && !report.comparison.sameModelValidated) {
      exitCode = 1;
    }
  }
} catch (error) {
  activeReporter?.finishWithError(error.message);
  activeReporter = null;
  const fallbackTarget = currentTarget || config.server.opencodeTargets.targets[0];
  if (!printedStartupTargets.has(fallbackTarget?.id || "default")) {
    environmentFailures.push(`Autorun：${error.message}`);
    printTargetStartup(fallbackTarget);
  }
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

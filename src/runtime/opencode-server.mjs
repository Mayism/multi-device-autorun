import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { OpenCodeClient } from "../agent/opencode-client.mjs";
import { OPENCODE_SOURCE_MODES, resolveOpenCodeSource } from "../agent/opencode-installation.mjs";
import { exists } from "../shared/fs.mjs";
import { interruptionError, throwIfInterrupted } from "../shared/runtime.mjs";
import { DEFAULT_OPENCODE_PORT, DEFAULT_OPENCODE_SERVER_URL } from "./opencode-defaults.mjs";

const AUTORUN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL_REQUEST_TIMEOUT_SEC = 30;
const SKILL_READY_TIMEOUT_SEC = 180;
const SKILL_RETRY_INTERVAL_MS = 2_000;

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

export async function waitForSkills(client, directory, {
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

export async function ensureOpenCodeServer(config, { log = console.log, signal } = {}) {
  if (signal?.aborted) throw interruptionError(signal.reason);
  const source = await resolveOpenCodeSource(config.server.opencodeSource);
  log(`[server] OpenCode 来源模式: ${source.mode}`);
  const configuredServerUrl = String(config.server.url || DEFAULT_OPENCODE_SERVER_URL).trim();
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

  const serveScript = fileURLToPath(new URL("../run-opencode-serve.mjs", import.meta.url));
  if (!await exists(serveScript)) throw new Error(`启动脚本不存在: ${serveScript}`);
  const runtimeRoot = config.server.runtimeRoot;
  const port = new URL(serverUrl).port || DEFAULT_OPENCODE_PORT;
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

export async function stopOwnedServer(server, { log = console.log } = {}) {
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


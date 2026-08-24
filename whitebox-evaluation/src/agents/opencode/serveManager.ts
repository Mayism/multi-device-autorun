import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { setTimeout as sleepTimer } from "node:timers/promises";
import type { OpencodeRuntimeConfig } from "./config.js";

const HEALTH_CHECK_TIMEOUT_MS = 2000;
const WATCHDOG_INTERVAL_MS = 10000;

export class OpencodeServeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OpencodeServeError";
  }
}

export interface OpencodeServeManager {
  start(): Promise<void>;
  restart(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<boolean>;
  serverUrl(): string;
}

type SpawnedProcess = Pick<ChildProcess, "stdout" | "stderr" | "on" | "kill">;

type KillSignal = "SIGTERM" | "SIGKILL";
type WatchdogTimer = { unref?: () => void };

type ServeManagerDeps = {
  checkHealth?: (serverUrl: string) => Promise<boolean>;
  spawnProcess?: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] },
  ) => SpawnedProcess;
  terminateExistingServer?: (config: OpencodeRuntimeConfig) => Promise<void>;
  collectListeningPids?: (port: number) => Promise<number[]>;
  killProcess?: (pid: number, signal: KillSignal) => void;
  sleep?: (ms: number) => Promise<void>;
  setWatchdogTimer?: (
    callback: () => void | Promise<void>,
    intervalMs: number,
  ) => WatchdogTimer;
  clearWatchdogTimer?: (timer: WatchdogTimer) => void;
};

export async function ensureOpencodeCliAvailable(deps: {
  commandExists?: () => Promise<boolean>;
} = {}): Promise<void> {
  const commandExists = deps.commandExists ?? defaultCommandExists;
  if (!(await commandExists())) {
    throw new OpencodeServeError("opencode CLI 不存在，请先安装 opencode 并确保它在 PATH 中");
  }
}

async function defaultCommandExists(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("opencode", ["--version"], {
      stdio: "ignore",
    });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

async function defaultCheckHealth(serverUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/global/health`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return false;
    }
    const data = (await response.json().catch(() => undefined)) as { healthy?: unknown } | undefined;
    return data?.healthy === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function streamSnippet(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString("utf-8").trim().slice(0, 1000);
}

function defaultSpawnProcess(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] },
): SpawnedProcess {
  return spawn(command, args, options);
}

async function collectListeningPids(port: number): Promise<number[]> {
  return new Promise((resolve) => {
    const child = spawn("lsof", ["-ti", `tcp:${String(port)}`, "-sTCP:LISTEN"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const stdout: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.on("error", () => resolve([]));
    child.on("exit", () => {
      const pids = Buffer.concat(stdout)
        .toString("utf-8")
        .split(/\s+/)
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0);
      resolve([...new Set(pids)]);
    });
  });
}

function defaultKillProcess(pid: number, signal: KillSignal): void {
  process.kill(pid, signal);
}

async function waitForPortRelease(input: {
  port: number;
  collectListeningPids: (port: number) => Promise<number[]>;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
}): Promise<number[]> {
  const startedAt = Date.now();
  let pids = await input.collectListeningPids(input.port);
  while (pids.length > 0 && Date.now() - startedAt < input.timeoutMs) {
    await input.sleep(100);
    pids = await input.collectListeningPids(input.port);
  }
  return pids;
}

async function defaultTerminateExistingServer(
  config: OpencodeRuntimeConfig,
  deps: {
    collectListeningPids?: (port: number) => Promise<number[]>;
    killProcess?: (pid: number, signal: KillSignal) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const collectPids = deps.collectListeningPids ?? collectListeningPids;
  const killProcess = deps.killProcess ?? defaultKillProcess;
  const sleep = deps.sleep ?? sleepTimer;
  const pids = await collectPids(config.port);
  for (const pid of pids) {
    try {
      killProcess(pid, "SIGTERM");
    } catch {
      // Process may have exited between discovery and termination.
    }
  }
  if (pids.length > 0) {
    const remainingPids = await waitForPortRelease({
      port: config.port,
      collectListeningPids: collectPids,
      sleep,
      timeoutMs: 1000,
    });
    for (const pid of remainingPids) {
      try {
        killProcess(pid, "SIGKILL");
      } catch {
        // Process may have exited after the final poll.
      }
    }
    if (remainingPids.length > 0) {
      await waitForPortRelease({
        port: config.port,
        collectListeningPids: collectPids,
        sleep,
        timeoutMs: 1000,
      });
    }
  }
}

export function createOpencodeServeManager(
  config: OpencodeRuntimeConfig,
  deps: ServeManagerDeps = {},
): OpencodeServeManager {
  const checkHealth = deps.checkHealth ?? defaultCheckHealth;
  const spawnProcess = deps.spawnProcess ?? defaultSpawnProcess;
  const terminateExistingServer =
    deps.terminateExistingServer ??
    ((runtimeConfig: OpencodeRuntimeConfig) =>
      defaultTerminateExistingServer(runtimeConfig, {
        collectListeningPids: deps.collectListeningPids,
        killProcess: deps.killProcess,
        sleep: deps.sleep,
      }));
  const collectPids = deps.collectListeningPids ?? collectListeningPids;
  const sleep = deps.sleep ?? sleepTimer;
  const setWatchdogTimer =
    deps.setWatchdogTimer ??
    ((callback: () => void | Promise<void>, intervalMs: number): WatchdogTimer =>
      setInterval(() => {
        void callback();
      }, intervalMs));
  const clearWatchdogTimer =
    deps.clearWatchdogTimer ?? ((timer: WatchdogTimer) => clearInterval(timer as NodeJS.Timeout));
  let child: SpawnedProcess | undefined;
  let startPromise: Promise<void> | undefined;
  let restartPromise: Promise<void> | undefined;
  let watchdogTimer: WatchdogTimer | undefined;
  let watchdogRunning = false;

  async function health(): Promise<boolean> {
    return checkHealth(config.serverUrl);
  }

  async function stopOwnedChild(): Promise<void> {
    if (!child) {
      return;
    }

    const ownedChild = child;
    child = undefined;
    ownedChild.kill("SIGTERM");
    const remainingPids = await waitForPortRelease({
      port: config.port,
      collectListeningPids: collectPids,
      sleep,
      timeoutMs: 1000,
    });
    if (remainingPids.length > 0) {
      ownedChild.kill("SIGKILL");
      await waitForPortRelease({
        port: config.port,
        collectListeningPids: collectPids,
        sleep,
        timeoutMs: 1000,
      });
    }
    await terminateExistingServer(config);
  }

  function stopWatchdog(): void {
    if (!watchdogTimer) {
      return;
    }
    clearWatchdogTimer(watchdogTimer);
    watchdogTimer = undefined;
  }

  async function waitForHealthy(shouldStop: () => boolean = () => false): Promise<void> {
    const startedAt = Date.now();
    const timeoutMs = Math.min(config.timeoutMs, 30000);
    while (!shouldStop() && Date.now() - startedAt < timeoutMs) {
      if (await health()) {
        return;
      }
      await sleep(250);
    }
    if (shouldStop()) {
      return;
    }
    throw new OpencodeServeError(`opencode serve 健康检查超时：${config.serverUrl}`);
  }

  function buildServeFailureMessage(input: {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: Buffer[];
    stderr: Buffer[];
  }): string {
    const stdout = streamSnippet(input.stdout);
    const stderr = streamSnippet(input.stderr);
    const details = [
      `serverUrl=${config.serverUrl}`,
      `exitCode=${String(input.code)}`,
      `signal=${String(input.signal)}`,
      stdout ? `stdout=${stdout}` : undefined,
      stderr ? `stderr=${stderr}` : undefined,
    ].filter((part): part is string => typeof part === "string");

    return `opencode serve 提前退出 ${details.join(" ")}`;
  }

  async function startServe(): Promise<void> {
    if (startPromise) {
      return startPromise;
    }
    startPromise = (async () => {
      if (child && (await health())) {
        return;
      }

      if (child) {
        await stopOwnedChild();
      }
      await terminateExistingServer(config);

      const args = [
        "serve",
        "--hostname",
        config.host,
        "--port",
        String(config.port),
        "--print-logs",
        "--log-level",
        "INFO",
      ];
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let childExited = false;

      const spawnedChild = spawnProcess("opencode", args, {
        env: config.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = spawnedChild;

      spawnedChild.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      spawnedChild.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

      const childFailure = new Promise<never>((_, reject) => {
        spawnedChild.on("error", (error) => {
          reject(
            new OpencodeServeError(
              `opencode serve 启动失败 serverUrl=${config.serverUrl} command=opencode ${args.join(" ")}`,
              { cause: error },
            ),
          );
        });
        spawnedChild.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
          childExited = true;
          if (child === spawnedChild) {
            child = undefined;
          }
          reject(new OpencodeServeError(buildServeFailureMessage({ code, signal, stdout, stderr })));
        });
      });
      childFailure.catch(() => undefined);

      await Promise.race([waitForHealthy(() => childExited), childFailure]);
      startWatchdog();
    })();
    try {
      await startPromise;
    } finally {
      startPromise = undefined;
    }
  }

  async function start(): Promise<void> {
    if (restartPromise) {
      await restartPromise;
      return;
    }
    await startServe();
  }

  async function restart(): Promise<void> {
    if (restartPromise) {
      return restartPromise;
    }
    restartPromise = (async () => {
      await stopOwnedChild();
      await startServe();
    })();
    try {
      await restartPromise;
    } finally {
      restartPromise = undefined;
    }
  }

  async function watchdogTick(): Promise<void> {
    if (watchdogRunning) {
      return;
    }
    watchdogRunning = true;
    try {
      if (!(await health())) {
        await restart();
      }
    } catch {
      try {
        await restart();
      } catch {
        // Keep the watchdog alive; the next tick will try again.
      }
    } finally {
      watchdogRunning = false;
    }
  }

  function startWatchdog(): void {
    if (watchdogTimer) {
      return;
    }
    watchdogTimer = setWatchdogTimer(watchdogTick, WATCHDOG_INTERVAL_MS);
    watchdogTimer.unref?.();
  }

  return {
    start,
    restart,

    async stop(): Promise<void> {
      stopWatchdog();
      await stopOwnedChild();
    },

    health,

    serverUrl(): string {
      return config.serverUrl;
    },
  };
}

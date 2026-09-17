import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import crypto from "node:crypto";
import type { DeviceConfig, CommandResult } from "../execution/types/index.js";
import {
  buildListForwardCommand,
  buildRemoveReversePortCommand,
  buildReversePortCommand,
} from "./forwarding.js";
import { healthCheck } from "./utils/healthCheck.js";
import {
  findAvailableFoldServerPort,
  isTcpPortAvailable,
} from "./utils/ports.js";
import {
  readFoldServerState,
  removeFoldServerState,
  writeFoldServerState,
  type FoldServerState,
} from "./state.js";

const START_PORT = 8766;
const MAX_PORT_ATTEMPTS = 100;
const HEALTH_TIMEOUT_MS = 10000;
const PORT_RELEASE_ATTEMPTS = 50;
const PORT_RELEASE_INTERVAL_MS = 100;
const MAX_STARTUP_OUTPUT_LENGTH = 4000;
const RPORT_CHECK_INTERVAL_MS = 5000;
const RPORT_RETRY_INTERVAL_MS = 1000;
const RPORT_MAX_RETRIES = 3;

class FoldServerPortConflictError extends Error {}

interface ReversePortKeeperInput {
  hdc: string;
  target: string;
  devicePort: number;
  port: number;
  runCommand: (command: string) => Promise<CommandResult>;
  platform: NodeJS.Platform;
}

/**
 * 折叠操作可能重建模拟器网络栈，使已建立的 hdc rport 丢失。
 * 保持器串行检查转发是否存在，丢失时自动重建。
 */
export class ReversePortKeeper {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private started = false;
  private stopping = false;

  constructor(
    private readonly input: ReversePortKeeperInput,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const active = this.inFlight;
    if (active) await active;
  }

  checkAndRecover(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const task = this.performCheckAndRecover()
      // 后台保持器不能用未处理的 HDC 异常终止 Runner。
      .catch(() => undefined)
      .finally(() => {
        if (this.inFlight === task) this.inFlight = null;
      });
    this.inFlight = task;
    return task;
  }

  async isForwardingActive(): Promise<boolean> {
    try {
      const listed = await this.input.runCommand(
        buildListForwardCommand(
          this.input.hdc,
          this.input.target,
          this.input.platform,
        ),
      );
      if (listed.exitCode !== 0) return false;
      const expectedSource = `tcp:${this.input.devicePort}`;
      const expectedDestination = `tcp:${this.input.port}`;
      return `${listed.stdout}\n${listed.stderr}`
        .split(/\r?\n/)
        .some((line) => {
          const match = line
            .trim()
            .match(/^(?:(\S+)\s+)?(\S+)\s+(\S+)\s+\[Reverse\]$/i);
          return Boolean(
            match &&
            (!match[1] || match[1] === this.input.target) &&
            match[2] === expectedSource &&
            match[3] === expectedDestination,
          );
        });
    } catch {
      return false;
    }
  }

  private scheduleNext(): void {
    if (!this.started || this.stopping || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.checkAndRecover().then(() => this.scheduleNext());
    }, RPORT_CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  private async performCheckAndRecover(): Promise<void> {
    if (this.stopping || (await this.isForwardingActive())) return;
    for (let attempt = 0; attempt < RPORT_MAX_RETRIES; attempt += 1) {
      if (this.stopping) return;
      try {
        const result = await this.input.runCommand(
          buildReversePortCommand(
            this.input.hdc,
            this.input.target,
            this.input.devicePort,
            this.input.port,
            this.input.platform,
          ),
        );
        if (reversePortSucceeded(result)) return;
      } catch {
        // HDC 重连期间命令可能直接抛错，按同一重试策略处理。
      }
      if (this.stopping || attempt + 1 >= RPORT_MAX_RETRIES) return;
      await this.sleep(RPORT_RETRY_INTERVAL_MS);
    }
  }
}

export interface ManagedFoldServerInstance extends FoldServerState {
  process: ChildProcess;
  stateFile: string;
  forwardKeeper?: ReversePortKeeper;
}

export interface FoldServerRuntime {
  spawnProcess: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
  checkHealth: typeof healthCheck;
  isPortAvailable: (port: number) => Promise<boolean>;
  ownerToken: () => string;
  killPid: (pid: number, signal: NodeJS.Signals) => void;
  platform: NodeJS.Platform;
  sleep: (ms: number) => Promise<void>;
}

export interface StartManagedFoldServerInput {
  device: DeviceConfig;
  foldServerScript: string;
  hdc: string;
  runCommand: (command: string) => Promise<CommandResult>;
  stateRoot?: string;
  runtime?: Partial<FoldServerRuntime>;
}

export interface FoldServerCleanupResult {
  ok: boolean;
  diagnostics: string[];
}

export interface StopManagedFoldServerInput {
  instance: ManagedFoldServerInstance;
  hdc: string;
  runCommand: (command: string) => Promise<CommandResult>;
  runtime?: Partial<FoldServerRuntime>;
}

export async function startManagedFoldServer(
  input: StartManagedFoldServerInput,
): Promise<ManagedFoldServerInstance> {
  const runtime = buildRuntime(input.runtime);
  try {
    await recoverManagedFoldServer(input, runtime);
  } catch (error) {
    throw new Error(`fold_cleanup_failed: ${errorMessage(error)}`);
  }
  let nextPort = START_PORT;
  const endPort = START_PORT + MAX_PORT_ATTEMPTS;
  while (nextPort < endPort) {
    const { port } = await findAvailableFoldServerPort(
      runtime.isPortAvailable,
      nextPort,
      endPort - nextPort,
    );
    nextPort = port + 1;
    let instance: ManagedFoldServerInstance;
    try {
      instance = await startCandidate(input, runtime, port);
    } catch (error) {
      if (error instanceof FoldServerPortConflictError) continue;
      throw error;
    }
    let forwarded: CommandResult | undefined;
    try {
      forwarded = await input.runCommand(
        buildReversePortCommand(
          input.hdc,
          input.device.target,
          instance.devicePort,
          instance.port,
          runtime.platform,
        ),
      );
    } catch {
      // Treat an HDC invocation failure like a rejected forwarding attempt.
    }
    if (forwarded && reversePortSucceeded(forwarded)) {
      attachReversePortKeeper(input, runtime, instance);
      return instance;
    }
    if (!(await rollbackCandidate(input, runtime, instance))) {
      throw new Error("fold_cleanup_failed");
    }
  }
  throw new Error("fold_server_port_unavailable");
}

function attachReversePortKeeper(
  input: StartManagedFoldServerInput,
  runtime: FoldServerRuntime,
  instance: ManagedFoldServerInstance,
): void {
  const keeper = new ReversePortKeeper(
    {
      hdc: input.hdc,
      target: input.device.target,
      devicePort: instance.devicePort,
      port: instance.port,
      runCommand: input.runCommand,
      platform: runtime.platform,
    },
    runtime.sleep,
  );
  instance.forwardKeeper = keeper;
  instance.process.once("close", () => {
    void keeper.stop();
  });
  keeper.start();
}

export async function stopManagedFoldServer(
  input: StopManagedFoldServerInput,
): Promise<FoldServerCleanupResult> {
  const runtime = buildRuntime(input.runtime);
  const diagnostics: string[] = [];
  await input.instance.forwardKeeper?.stop();
  try {
    const removed = await removeAndVerifyForward(
      input.hdc,
      input.instance,
      input.runCommand,
      runtime,
    );
    if (!removed) {
      diagnostics.push("fold_forward_cleanup_failed");
    }
  } catch (error) {
    diagnostics.push(`fold_forward_cleanup_failed: ${errorMessage(error)}`);
  }
  if (!terminateChild(input.instance.process)) {
    diagnostics.push("fold_server_stop_failed");
  }
  if (!(await waitForPortRelease(input.instance.port, runtime))) {
    diagnostics.push("fold_server_port_release_failed");
  }
  if (diagnostics.length === 0) {
    try {
      await removeFoldServerState(input.instance.stateFile);
    } catch (error) {
      diagnostics.push(`fold_state_cleanup_failed: ${errorMessage(error)}`);
    }
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

async function startCandidate(
  input: StartManagedFoldServerInput,
  runtime: FoldServerRuntime,
  port: number,
): Promise<ManagedFoldServerInstance> {
  const spawned = spawnFoldProcess(input, runtime, port);
  const { child, ownerToken } = spawned;
  if (child.pid === undefined) throw new Error("fold_server_start_failed");
  const state = createCandidateState(input, child.pid, port, ownerToken);
  const stateFile = await persistCandidateState(input, runtime, child, state);
  const instance = { ...state, process: child, stateFile };
  const healthy = await runtime.checkHealth(
    port,
    HEALTH_TIMEOUT_MS,
    ownerToken,
    () => !spawned.hasError() && !childHasExited(child),
  );
  if (healthy && !childHasExited(child)) return instance;
  const exitedBeforeCleanup = childHasExited(child);
  const portOccupied =
    exitedBeforeCleanup && !(await runtime.isPortAvailable(port));
  if (!(await discardUnforwardedCandidate(instance, runtime))) {
    throw new Error("fold_cleanup_failed");
  }
  if (
    exitedBeforeCleanup &&
    (portOccupied || isPortConflictOutput(spawned.output()))
  ) {
    throw new FoldServerPortConflictError();
  }
  const detail = spawned.failureDetail();
  throw new Error(
    detail ? `fold_server_start_failed: ${detail}` : "fold_server_start_failed",
  );
}

interface SpawnedFoldProcess {
  child: ChildProcess;
  ownerToken: string;
  hasError: () => boolean;
  output: () => string;
  failureDetail: () => string;
}

function spawnFoldProcess(
  input: StartManagedFoldServerInput,
  runtime: FoldServerRuntime,
  port: number,
): SpawnedFoldProcess {
  const ownerToken = runtime.ownerToken();
  let spawnError: Error | undefined;
  let startupOutput = "";
  const child = runtime.spawnProcess(
    runtime.platform === "win32" ? "python" : "python3",
    foldServerArgs(input, port, ownerToken),
    { detached: false, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.on("error", (error) => {
    spawnError = error;
  });
  const capture = (chunk: unknown) => {
    startupOutput = `${startupOutput}${String(chunk)}`.slice(
      -MAX_STARTUP_OUTPUT_LENGTH,
    );
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return {
    child,
    ownerToken,
    hasError: () => spawnError !== undefined,
    output: () => startupOutput,
    failureDetail: () =>
      [spawnError?.message, startupOutput.trim()].filter(Boolean).join("; "),
  };
}

function foldServerArgs(
  input: StartManagedFoldServerInput,
  port: number,
  ownerToken: string,
): string[] {
  return [
    input.foldServerScript,
    "--profile",
    input.device.profile ?? input.device.id,
    "--port",
    String(port),
    "--target",
    input.device.target,
    "--forwarding",
    "external",
    "--owner-token",
    ownerToken,
  ];
}

function createCandidateState(
  input: StartManagedFoldServerInput,
  pid: number,
  port: number,
  ownerToken: string,
): FoldServerState {
  const devicePort = port - 1;
  return {
    schemaVersion: 1,
    pid,
    port,
    devicePort,
    target: input.device.target,
    ownerToken,
    forwardTask: `tcp:${devicePort} tcp:${port}`,
    createdAt: new Date().toISOString(),
  };
}

async function persistCandidateState(
  input: StartManagedFoldServerInput,
  runtime: FoldServerRuntime,
  child: ChildProcess,
  state: FoldServerState,
): Promise<string> {
  try {
    return await writeFoldServerState(state, input.hdc, input.stateRoot);
  } catch (error) {
    if (!(await stopChildAndWait(child, runtime))) {
      throw new Error(`fold_cleanup_failed: ${errorMessage(error)}`);
    }
    throw error;
  }
}

async function discardUnforwardedCandidate(
  instance: ManagedFoldServerInstance,
  runtime: FoldServerRuntime,
): Promise<boolean> {
  if (!(await stopChildAndWait(instance.process, runtime))) return false;
  try {
    await removeFoldServerState(instance.stateFile);
    return true;
  } catch {
    return false;
  }
}

async function rollbackCandidate(
  input: StartManagedFoldServerInput,
  runtime: FoldServerRuntime,
  instance: ManagedFoldServerInstance,
): Promise<boolean> {
  let clean = true;
  try {
    clean = await removeAndVerifyForward(
      input.hdc,
      instance,
      input.runCommand,
      runtime,
    );
  } catch {
    clean = false;
  }
  if (!terminateChild(instance.process)) clean = false;
  if (!(await waitForPortRelease(instance.port, runtime))) clean = false;
  if (clean) {
    try {
      await removeFoldServerState(instance.stateFile);
    } catch {
      clean = false;
    }
  }
  return clean;
}

async function recoverManagedFoldServer(
  input: StartManagedFoldServerInput,
  runtime: FoldServerRuntime,
): Promise<void> {
  const stored = await readFoldServerState(
    input.hdc,
    input.device.target,
    input.stateRoot,
  );
  if (!stored) return;
  const { state, stateFile } = stored;
  const owned = await runtime.checkHealth(state.port, 1000, state.ownerToken);
  if (owned) {
    try {
      runtime.killPid(state.pid, "SIGTERM");
    } catch (error) {
      if (!isMissingProcess(error)) throw error;
    }
    if (!(await waitForPortRelease(state.port, runtime))) {
      throw new Error("fold_cleanup_failed");
    }
  } else if (!(await runtime.isPortAvailable(state.port))) {
    throw new Error("fold_cleanup_failed");
  }
  const forwardRemoved = await removeAndVerifyForward(
    input.hdc,
    state,
    input.runCommand,
    runtime,
  );
  if (!forwardRemoved) throw new Error("fold_forward_cleanup_failed");
  await removeFoldServerState(stateFile);
}

function buildRuntime(
  overrides: Partial<FoldServerRuntime> | undefined,
): FoldServerRuntime {
  return {
    spawnProcess: (command, args, options) => spawn(command, args, options),
    checkHealth: healthCheck,
    isPortAvailable: isTcpPortAvailable,
    ownerToken: crypto.randomUUID,
    killPid: (pid, signal) => process.kill(pid, signal),
    platform: process.platform,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...overrides,
  };
}

function terminateChild(child: ChildProcess): boolean {
  if (childHasExited(child) || child.killed) return true;
  try {
    return child.kill("SIGTERM");
  } catch {
    return false;
  }
}

function reversePortSucceeded(result: CommandResult): boolean {
  return result.exitCode === 0 && /\bOK\b/i.test(`${result.stdout}\n${result.stderr}`);
}

async function waitForPortRelease(
  port: number,
  runtime: FoldServerRuntime,
): Promise<boolean> {
  for (let attempt = 0; attempt < PORT_RELEASE_ATTEMPTS; attempt += 1) {
    if (await runtime.isPortAvailable(port)) return true;
    await runtime.sleep(PORT_RELEASE_INTERVAL_MS);
  }
  return false;
}

async function stopChildAndWait(
  child: ChildProcess,
  runtime: FoldServerRuntime,
): Promise<boolean> {
  if (!terminateChild(child)) return false;
  for (let attempt = 0; attempt < PORT_RELEASE_ATTEMPTS; attempt += 1) {
    if (childHasExited(child)) return true;
    await runtime.sleep(PORT_RELEASE_INTERVAL_MS);
  }
  return false;
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode != null;
}

function isPortConflictOutput(output: string): boolean {
  return /address already in use|EADDRINUSE|WinError 10048/i.test(output);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingProcess(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ESRCH";
}

async function removeAndVerifyForward(
  hdc: string,
  state: Pick<
    FoldServerState,
    "target" | "devicePort" | "port" | "forwardTask"
  >,
  runCommand: (command: string) => Promise<CommandResult>,
  runtime: FoldServerRuntime,
): Promise<boolean> {
  await runCommand(
    buildRemoveReversePortCommand(
      hdc,
      state.target,
      state.devicePort,
      state.port,
      runtime.platform,
    ),
  );
  const listed = await runCommand(
    buildListForwardCommand(hdc, state.target, runtime.platform),
  );
  return (
    listed.exitCode === 0 &&
    !`${listed.stdout}\n${listed.stderr}`.includes(state.forwardTask)
  );
}

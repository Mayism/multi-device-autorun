import { spawn, execFile, type ChildProcess } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

export interface ProcessExit {
  code: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
}

export interface OwnedProcess {
  child: ChildProcess;
  exit?: ProcessExit;
  closed: Promise<ProcessExit>;
  stopping?: Promise<void>;
}

export function startProcess(input: {
  file: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  log: string;
}): OwnedProcess {
  const logFd = openSync(input.log, "w");
  let child: ChildProcess;
  try {
    child = spawn(input.file, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", logFd, logFd],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
  } finally {
    closeSync(logFd);
  }
  const owned: OwnedProcess = {
    child,
    closed: Promise.resolve({ code: null }),
  };
  owned.closed = new Promise((resolve) => {
    let error: string | undefined;
    child.on("error", (value) => {
      error = value.message;
    });
    child.once("close", (code, signal) => {
      owned.exit = { code, signal, ...(error ? { error } : {}) };
      resolve(owned.exit);
    });
  });
  return owned;
}

export async function waitForExit(
  owned: OwnedProcess,
  signal: AbortSignal,
): Promise<ProcessExit> {
  // Downloads and lifecycle scripts have no fixed total duration. Await exit or cancellation.
  signal.throwIfAborted();
  return new Promise<ProcessExit>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void owned.closed.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(signal.reason);
        else resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function assertRunning(owned: OwnedProcess): void {
  if (
    owned.exit ||
    owned.child.exitCode !== null ||
    owned.child.signalCode !== null
  ) {
    throw new Error(
      `web_server_exited: ${JSON.stringify(owned.exit ?? { code: owned.child.exitCode, signal: owned.child.signalCode })}`,
    );
  }
}

export function stopProcess(owned: OwnedProcess): Promise<void> {
  owned.stopping ??= terminateProcessTree(owned);
  return owned.stopping;
}

async function terminateProcessTree(owned: OwnedProcess): Promise<void> {
  const pid = owned.child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    if (owned.exit) return;
    try {
      await promisify(execFile)(
        "taskkill.exe",
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: 5000 },
      );
    } catch (error) {
      if (!owned.exit) throw error;
    }
  } else {
    signalGroup(pid, "SIGTERM");
    await sleep(200);
    signalGroup(pid, "SIGKILL");
  }
  const deadline = Date.now() + 5000;
  while (!owned.exit && Date.now() < deadline) await sleep(50);
  if (!owned.exit) throw new Error(`web_process_stop_timeout: ${pid}`);
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

import { spawn, type ChildProcess } from "node:child_process";
import { TextDecoder } from "node:util";
import type {
  CommandExecutionOptions,
  CommandExecutor,
  CommandResult,
} from "./types/index.js";

const utf8Decoder = new TextDecoder("utf-8");
const windowsDecoder = new TextDecoder("gb18030");
const maxCommandOutputChars = 1024 * 1024 * 20;
const timeoutExitCode = 124;

interface CommandCompletion {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutMs?: number;
  exitCode: number;
  started: number;
}

export const defaultCommandExecutor: CommandExecutor = async (
  command,
  cwd,
  options,
) => runCommand(command, cwd, options);

async function runCommand(
  command: string,
  cwd: string,
  options: CommandExecutionOptions = {},
): Promise<CommandResult> {
  const started = Date.now();
  let child: ChildProcess;
  try {
    child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 1,
      durationMs: Date.now() - started,
    };
  }

  return waitForCommand(child, started, options.timeoutMs);
}

function waitForCommand(
  child: ChildProcess,
  started: number,
  timeoutMs?: number,
): Promise<CommandResult> {
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  return new Promise<CommandResult>((resolve) => {
    let settled = false;
    let cancelTimeout = (): void => undefined;
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      cancelTimeout();
      resolve(
        completedCommandResult({
          stdout,
          stderr,
          timedOut,
          timeoutMs,
          exitCode,
          started,
        }),
      );
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendLimitedOutput(stdout, decodeCommandOutput(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendLimitedOutput(stderr, decodeCommandOutput(chunk));
    });
    child.once("error", (error) => {
      stderr = appendLimitedOutput(stderr, error.message);
      finish(1);
    });
    child.once("close", (code) => finish(code ?? 1));

    cancelTimeout = scheduleCommandTimeout(
      child,
      timeoutMs,
      () => {
        timedOut = true;
      },
      () => finish(timeoutExitCode),
      () => settled,
    );
  });
}

function scheduleCommandTimeout(
  child: ChildProcess,
  timeoutMs: number | undefined,
  onTimeout: () => void,
  onFallback: () => void,
  isSettled: () => boolean,
): () => void {
  let fallback: ReturnType<typeof setTimeout> | undefined;
  if (!timeoutMs || timeoutMs <= 0) return () => undefined;
  const timeout = setTimeout(() => {
    onTimeout();
    void terminateProcessTree(child).finally(() => {
      if (isSettled()) return;
      fallback = setTimeout(onFallback, 5000);
      fallback.unref?.();
    });
  }, timeoutMs);
  timeout.unref?.();
  return () => {
    clearTimeout(timeout);
    clearTimeout(fallback);
  };
}

function completedCommandResult(input: CommandCompletion): CommandResult {
  const { stdout, stderr, timedOut, timeoutMs, exitCode, started } = input;
  return {
    stdout,
    stderr: timedOut
      ? appendLimitedOutput(stderr, `\ncommand timed out after ${timeoutMs} ms`)
      : stderr,
    exitCode: timedOut ? timeoutExitCode : exitCode,
    durationMs: Date.now() - started,
    ...(timedOut ? { timedOut: true } : {}),
  };
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill.exe",
        ["/pid", String(child.pid), "/t", "/f"],
        {
          windowsHide: true,
          stdio: "ignore",
        },
      );
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function appendLimitedOutput(current: string, value: string): string {
  return `${current}${value}`.slice(-maxCommandOutputChars);
}

export async function runDetachedCommand(
  command: string,
  cwd: string,
  startupTimeoutMs = 10000,
): Promise<CommandResult> {
  const started = Date.now();
  try {
    const child = spawn(command, {
      cwd,
      detached: true,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return await waitForDetachedStartup(child, started, startupTimeoutMs);
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 1,
      durationMs: Date.now() - started,
    };
  }
}

function waitForDetachedStartup(
  child: ChildProcess,
  started: number,
  startupTimeoutMs: number,
): Promise<CommandResult> {
  let stdout = "";
  let stderr = "";

  return new Promise<CommandResult>((resolve) => {
    let settled = false;
    const finish = (result: Omit<CommandResult, "durationMs">): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ ...result, durationMs: Date.now() - started });
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendCommandOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendCommandOutput(stderr, chunk);
    });
    child.on("error", (error) =>
      finish({ stdout, stderr: stderr || error.message, exitCode: 1 }),
    );
    child.on("close", (code) =>
      finish({ stdout, stderr, exitCode: code ?? 0 }),
    );

    const timeout = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      finish({ stdout, stderr, exitCode: 0 });
    }, startupTimeoutMs);
  });
}

function appendCommandOutput(current: string, chunk: Buffer): string {
  return `${current}${decodeCommandOutput(chunk)}`.slice(-1024 * 1024);
}

export function decodeCommandOutput(
  chunk: Buffer,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32"
    ? windowsDecoder.decode(chunk)
    : utf8Decoder.decode(chunk);
}

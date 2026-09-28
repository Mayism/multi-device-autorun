import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export interface NativeJob {
  readonly pid: number;
}
export interface JobState {
  active: number;
  code: number | null;
}
export interface WindowsJobApi {
  launch(
    file: string,
    command: string,
    cwd: string,
    log: string,
    env: Buffer,
  ): NativeJob;
  poll(job: NativeJob): JobState;
  terminate(job: NativeJob): void;
  close(job: NativeJob): void;
}

let binding: WindowsJobApi | undefined;

export function loadWindowsJob(): WindowsJobApi {
  if (process.platform !== "win32") throw new Error("web_job_windows_only");
  if (binding) return binding;
  const relative = `native/windows-job/prebuilds/win32-${process.arch}/web-job.node`;
  // Source/tsx and tsc's dist layout both use the repository's native directory.
  const candidates = [
    new URL(`../../../${relative}`, import.meta.url),
    new URL(`../../../../${relative}`, import.meta.url),
  ].map((url) => fileURLToPath(url));
  const binary = candidates.find((candidate) => existsSync(candidate));
  if (!binary)
    throw new Error(
      `web_job_binary_missing: ${process.arch}; retain native/windows-job/prebuilds alongside the Runner`,
    );
  try {
    binding = createRequire(import.meta.url)(binary) as WindowsJobApi;
    return binding;
  } catch (error) {
    throw new Error(
      `web_job_binary_load_failed: ${process.arch}: ${String(error)}`,
      { cause: error },
    );
  }
}

export function windowsCommand(file: string, args: string[]): string {
  return [file, ...args]
    .map((value) => {
      if (value.includes("\0")) throw new Error("web_job_argument_nul");
      // Windows CRT quoting: double slashes before quotes and the closing quote.
      return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
    })
    .join(" ");
}

export function windowsEnvironment(env: NodeJS.ProcessEnv): Buffer {
  const seen = new Set<string>();
  const entries: string[] = [];
  // Match Node's Windows rule: first case-insensitive key in sorted order wins.
  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    const normalized = key.toUpperCase();
    if (value === undefined || seen.has(normalized)) continue;
    if (key.includes("\0") || key.includes("=") || value.includes("\0"))
      throw new Error("web_job_invalid_environment");
    seen.add(normalized);
    entries.push(`${key}=${value}`);
  }
  entries.sort((left, right) =>
    left.toUpperCase() < right.toUpperCase() ? -1 : 1,
  );
  return Buffer.from(`${entries.join("\0")}\0\0`, "utf16le");
}

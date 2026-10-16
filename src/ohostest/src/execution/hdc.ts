import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CommandExecutor,
  StreamingCommandExecutor,
} from "./types/index.js";
import { shellQuote } from "./utils/shellQuote.js";

/** HDC can start a long-lived server that inherits the client's cwd. */
export function withHdcWorkingDirectory(
  executor: CommandExecutor,
  hdc: string,
  platform?: NodeJS.Platform,
): CommandExecutor;
export function withHdcWorkingDirectory(
  executor: StreamingCommandExecutor,
  hdc: string,
  platform?: NodeJS.Platform,
): StreamingCommandExecutor;
export function withHdcWorkingDirectory(
  executor: CommandExecutor | StreamingCommandExecutor,
  hdc: string,
  platform: NodeJS.Platform = process.platform,
): CommandExecutor | StreamingCommandExecutor {
  if (platform !== "win32") return executor;
  // Runner-generated HDC commands all start with this exact executable token.
  // Do not change the cwd of build commands that only mention HDC in arguments.
  const prefix = `${shellQuote(hdc, platform)} `;
  return (async (command: string, cwd: string, ...rest: never[]) => {
    if (!command.startsWith(prefix)) return executor(command, cwd, ...rest);
    const executable = await resolveWindowsHdc(hdc, cwd);
    const resolvedCommand = `${shellQuote(executable, platform)} ${command.slice(prefix.length)}`;
    return executor(resolvedCommand, os.tmpdir(), ...rest);
  }) as CommandExecutor | StreamingCommandExecutor;
}

async function resolveWindowsHdc(hdc: string, cwd: string): Promise<string> {
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(hdc)) return hdc;
  if (/[\\/:]/.test(hdc)) return path.win32.resolve(cwd, hdc);
  // Preserve cmd.exe's current-directory lookup before falling back to PATH.
  const extensions = path.win32.extname(hdc)
    ? [""]
    : (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";");
  for (const extension of extensions) {
    const candidate = path.win32.resolve(cwd, `${hdc}${extension}`);
    if ((await fs.stat(candidate).catch(() => undefined))?.isFile()) {
      return candidate;
    }
  }
  return hdc;
}

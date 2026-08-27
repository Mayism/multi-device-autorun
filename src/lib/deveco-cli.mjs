import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { TextDecoder } from "node:util";

export const DEVECO_CLI_COMMAND = "devecocli";
export const DEVECO_CLI_INSTALL_COMMAND = "npm install -g @deveco/deveco-cli@latest";

function pathEntries(env) {
  const value = env.PATH || env.Path || env.path || "";
  return value
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function executableNames(platform, env) {
  if (platform !== "win32") return [DEVECO_CLI_COMMAND];
  const extensions = String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  // npm on Windows creates both an extensionless POSIX shim and a .cmd shim.
  // cmd.exe cannot execute the extensionless file, so only consider PATHEXT
  // candidates executable on Windows.
  return [...new Set(extensions.map((extension) => (
    `${DEVECO_CLI_COMMAND}${extension.startsWith(".") ? extension : `.${extension}`}`
  )))];
}

async function findDevEcoCli({ env, platform }) {
  const accessMode = platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK;
  for (const directory of pathEntries(env)) {
    for (const name of executableNames(platform, env)) {
      const candidate = path.join(directory, name);
      try {
        await fs.access(candidate, accessMode);
        return candidate;
      } catch {
        // 继续检查 PATH 中的下一个候选文件。
      }
    }
  }
  return "";
}

function versionInvocation(executable, { env, platform }) {
  if (platform !== "win32") {
    return { command: executable, args: ["--version"] };
  }
  const extension = path.extname(executable).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") {
    return { command: executable, args: ["--version"] };
  }
  // `call` keeps a quoted .cmd/.bat path with spaces from being misparsed as
  // cmd.exe's own outer command quotes.
  const commandLine = `call "${executable.replaceAll('"', '""')}" --version`;
  return {
    command: env.ComSpec || env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", commandLine],
  };
}

export function decodeDevEcoCliOutput(chunks, platform) {
  const buffer = Buffer.concat(chunks.map((chunk) => (
    Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  )));
  if (!buffer.length) return "";
  if (platform !== "win32") return new TextDecoder("utf-8").decode(buffer);
  try {
    // Node-based CLI output is normally UTF-8 (and versions are ASCII), while
    // cmd.exe localized errors follow the Windows code page. Prefer valid UTF-8
    // and fall back to GB18030 for Simplified Chinese Windows diagnostics.
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("gb18030").decode(buffer);
  }
}

function readVersion(executable, { env, platform, timeoutMs = 5000 }) {
  const invocation = versionInvocation(executable, { env, platform });
  return new Promise((resolve) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    const child = spawn(invocation.command, invocation.args, {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      resolve({ version: "", error: `版本检测超过 ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => { stdoutChunks.push(chunk); });
    child.stderr?.on("data", (chunk) => { stderrChunks.push(chunk); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ version: "", error: error.message });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = decodeDevEcoCliOutput(stdoutChunks, platform);
      const stderr = decodeDevEcoCliOutput(stderrChunks, platform);
      const output = `${stdout}\n${stderr}`.trim();
      const version = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
      resolve({
        version: code === 0 ? version : "",
        error: code === 0 ? "" : output || `退出码 ${code}`,
      });
    });
  });
}

export async function detectDevEcoCli({
  env = process.env,
  platform = process.platform,
  versionReader = readVersion,
} = {}) {
  const executable = await findDevEcoCli({ env, platform });
  if (!executable) {
    return {
      installed: false,
      command: DEVECO_CLI_COMMAND,
      installCommand: DEVECO_CLI_INSTALL_COMMAND,
    };
  }
  const result = await versionReader(executable, { env, platform });
  return {
    installed: true,
    command: DEVECO_CLI_COMMAND,
    executable,
    version: String(result?.version || "").trim(),
    versionError: String(result?.error || "").trim(),
    installCommand: DEVECO_CLI_INSTALL_COMMAND,
  };
}

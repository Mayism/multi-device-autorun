import process from "node:process";
import { spawn } from "node:child_process";
import { TextDecoder } from "node:util";

export const DEVECO_CLI_COMMAND = "devecocli";
export const DEVECO_CLI_INSTALL_COMMAND = "npm install -g @deveco/deveco-cli@latest";

export function createDevEcoCliVersionInvocation({ env, platform }) {
  if (platform === "win32") {
    return {
      command: `${DEVECO_CLI_COMMAND} --version`,
      args: [],
      // Let cmd.exe resolve the npm-generated devecocli.cmd shim from PATH.
      // Passing a fixed command string through Node's shell integration avoids
      // manually nesting and escaping quotes around an absolute .cmd path.
      shell: env.ComSpec || env.COMSPEC || "cmd.exe",
    };
  }
  return {
    command: DEVECO_CLI_COMMAND,
    args: ["--version"],
    shell: false,
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

function readVersion({ env, platform, timeoutMs = 5000 }) {
  const invocation = createDevEcoCliVersionInvocation({ env, platform });
  return new Promise((resolve) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    const child = spawn(invocation.command, invocation.args, {
      env,
      shell: invocation.shell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      resolve({ ok: false, version: "", error: `版本检测超过 ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => { stdoutChunks.push(chunk); });
    child.stderr?.on("data", (chunk) => { stderrChunks.push(chunk); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, version: "", error: error.message });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = decodeDevEcoCliOutput(stdoutChunks, platform);
      const stderr = decodeDevEcoCliOutput(stderrChunks, platform);
      const output = `${stdout}\n${stderr}`.trim();
      const version = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
      const ok = code === 0 && Boolean(version);
      resolve({
        ok,
        version: ok ? version : "",
        error: ok
          ? ""
          : output || (code === 0 ? "命令执行成功但未返回版本" : `退出码 ${code}`),
      });
    });
  });
}

export async function detectDevEcoCli({
  env = process.env,
  platform = process.platform,
  versionReader = readVersion,
} = {}) {
  const result = await versionReader({ env, platform });
  const version = String(result?.version || "").trim();
  const error = String(result?.error || "").trim();
  return {
    installed: result?.ok === true && Boolean(version),
    command: DEVECO_CLI_COMMAND,
    version,
    error,
    installCommand: DEVECO_CLI_INSTALL_COMMAND,
  };
}

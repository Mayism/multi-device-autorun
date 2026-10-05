import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function pythonCommands() {
  if (process.env.AUTORUN_PYTHON) return [process.env.AUTORUN_PYTHON];
  return process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
}

function workerOptions() {
  return {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: [REPO_ROOT, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      PYTHONIOENCODING: "utf-8",
    },
    windowsHide: true,
  };
}

function execute(command, action, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["-B", "-m", "pyautorun.worker", action], {
      ...workerOptions(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`Python ${action} 失败 (${code}): ${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export async function runPythonWorker(action, input) {
  let missing;
  for (const command of pythonCommands()) {
    try {
      return await execute(command, action, input);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing = error;
    }
  }
  throw new Error(`找不到 Python 3.9+；可设置 AUTORUN_PYTHON 指向解释器: ${missing?.message || ""}`);
}

// Preserve synchronous public helpers while moving their computation to Python.
export function runPythonWorkerSync(action, input) {
  let missing;
  for (const command of pythonCommands()) {
    const result = spawnSync(command, ["-B", "-m", "pyautorun.worker", action], {
      ...workerOptions(),
      input: JSON.stringify(input),
      maxBuffer: 128 * 1024 * 1024,
    });
    if (result.error?.code === "ENOENT") {
      missing = result.error;
      continue;
    }
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Python ${action} 失败 (${result.status}): ${result.stderr.toString("utf8").trim()}`);
    }
    return result.stdout;
  }
  throw new Error(`找不到 Python 3.9+；可设置 AUTORUN_PYTHON 指向解释器: ${missing?.message || ""}`);
}

async function executeSession(command, moduleName, input, handler) {
  const child = spawn(command, ["-u", "-B", "-m", moduleName], {
    ...workerOptions(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.on("error", () => {});
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.write(`${JSON.stringify(input)}\n`);
  let result;
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.type === "result") {
        result = message.result;
        continue;
      }
      if (message.type === "error") throw new Error(message.message);
      try {
        const response = await handler(message);
        child.stdin.write(`${JSON.stringify({ ok: true, result: response })}\n`);
      } catch (error) {
        child.stdin.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
      }
    }
    const code = await closed;
    if (code !== 0) throw new Error(`${moduleName} 失败 (${code}): ${Buffer.concat(stderr).toString("utf8").trim()}`);
    if (result === undefined) throw new Error(`${moduleName} 未返回结果`);
    return result;
  } catch (error) {
    child.kill();
    await closed.catch(() => {});
    throw error;
  }
}

/** Line-oriented Python RPC for steps that must call the existing logged command executor. */
export async function runPythonSession(moduleName, input, handler) {
  let missing;
  for (const command of pythonCommands()) {
    try {
      return await executeSession(command, moduleName, input, handler);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing = error;
    }
  }
  throw new Error(`找不到 Python 3.9+；可设置 AUTORUN_PYTHON 指向解释器: ${missing?.message || ""}`);
}

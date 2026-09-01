import fs from "node:fs/promises";
import process from "node:process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_SEC = 900;

async function readLease(lockPath) {
  try {
    return JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function removeStaleLease(lockPath) {
  const lease = await readLease(lockPath);
  if (!lease || !processExists(Number(lease.pid))) {
    await fs.rm(lockPath, { force: true }).catch(() => {});
    return true;
  }
  return false;
}

export async function acquireDeviceLease({ lockPath, owner, timeoutSec = DEFAULT_TIMEOUT_SEC, signal }) {
  const timeoutMs = Math.max(1, Number(timeoutSec) || DEFAULT_TIMEOUT_SEC) * 1000;
  const startedAt = Date.now();
  const token = randomUUID();
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    if (signal?.aborted) throw signal.reason || new Error("等待设备租约时已中断");
    try {
      const handle = await fs.open(lockPath, "wx");
      const lease = {
        token,
        owner: String(owner || "unknown"),
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      };
      await handle.writeFile(`${JSON.stringify(lease)}\n`, "utf8");
      await handle.close();
      return lease;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await removeStaleLease(lockPath);
      if (Date.now() - startedAt >= timeoutMs) {
        const current = await readLease(lockPath);
        throw new Error(`等待设备租约超时（${Math.ceil(timeoutMs / 1000)} 秒），当前持有者: ${current?.owner || "未知"}`);
      }
      await delay(500);
    }
  }
}

export async function releaseDeviceLease(lockPath, token) {
  const current = await readLease(lockPath);
  if (!current || current.token !== token) return;
  await fs.rm(lockPath, { force: true });
}

export async function withDeviceLease(options, work) {
  const lease = await acquireDeviceLease(options);
  try {
    return await work(lease);
  } finally {
    await releaseDeviceLease(options.lockPath, lease.token).catch(() => {});
  }
}

function parseCli(argv) {
  if (argv.shift() !== "run") throw new Error("用法: node device-lease.mjs run --lock PATH --owner NAME -- <命令> [参数]");
  let lockPath = "";
  let owner = "agent";
  let timeoutSec = DEFAULT_TIMEOUT_SEC;
  while (argv.length) {
    const value = argv.shift();
    if (value === "--") break;
    if (value === "--lock") lockPath = String(argv.shift() || "");
    else if (value === "--owner") owner = String(argv.shift() || "agent");
    else if (value === "--timeout-sec") timeoutSec = Math.max(1, Number(argv.shift()) || DEFAULT_TIMEOUT_SEC);
    else throw new Error(`未知参数: ${value}`);
  }
  if (!lockPath || !argv.length) throw new Error("必须提供 --lock 和 -- 后的设备验证命令");
  return { lockPath, owner, timeoutSec, command: argv.shift(), args: argv };
}

async function runCli() {
  const options = parseCli(process.argv.slice(2));
  const result = await withDeviceLease(options, () => new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, { stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code: code ?? 1, signal: signal || "" }));
  }));
  process.exitCode = result.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(`[device-lease] ${error.message}`);
    process.exitCode = 1;
  });
}

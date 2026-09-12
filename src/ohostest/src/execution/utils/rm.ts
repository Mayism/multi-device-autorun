import fs from "node:fs/promises";
import { exec as nodeExec } from "node:child_process";
import { promisify } from "node:util";
import { shellQuote } from "./shellQuote.js";
import { sleep } from "./sleep.js";

const execAsync = promisify(nodeExec);

/**
 * hvigor daemon 退出码归一化：daemon 可能已退出导致非零退出码，属正常情况。
 */
function daemonStopResult(result: { stdout: string; stderr: string }): {
  stdout: string;
  stderr: string;
} {
  return { stdout: result.stdout, stderr: result.stderr };
}

/**
 * 关闭 hvigor daemon 进程，释放其对 work 目录内文件的锁定。
 *
 * 在删除 work 目录前调用，避免 Windows 上 EBUSY/resource busy or locked。
 * - 先执行 `hvigorw --stop-daemon`（关闭当前项目关联的 daemon）
 * - 再执行 `hvigorw --stop-daemon-all`（关闭所有 daemon）
 * - 等待 2 秒，确保 daemon 进程完全退出并释放文件句柄
 *
 * 注意：cwd 必须设置为 workProject，避免在 hvigorw 所在目录执行时
 * 因无写权限而失败（hvigorw 在 DevEco 安装目录下，通常只读）。
 */
export async function stopHvigorDaemon(
  hvigorw: string,
  workProject: string,
  options: { settleMs?: number; logger?: (line: string) => void } = {},
): Promise<void> {
  const settleMs = options.settleMs ?? 2000;
  const log = options.logger ?? (() => {});
  const quotedHvigorw = shellQuote(hvigorw);
  const commands = [
    `${quotedHvigorw} --stop-daemon`,
    `${quotedHvigorw} --stop-daemon-all`,
  ];
  for (const command of commands) {
    try {
      const result = await execAsync(command, {
        cwd: workProject,
        maxBuffer: 1024 * 1024 * 20,
      });
      log(`${command}: ${daemonStopResult(result).stdout.trim()}`);
    } catch (error) {
      // daemon 未运行或已退出时退出码非零，属预期情况，不阻断清理流程。
      const maybe = error as {
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      log(`${command}: ${maybe.stderr?.trim() || maybe.message || "failed"}`);
    }
  }
  if (settleMs > 0) {
    await sleep(settleMs);
  }
}

/**
 * 以递归方式删除路径，对瞬态文件锁错误（EBUSY/EPERM/ENOTEMPTY/EMFILE）
 * 进行指数退避重试。
 *
 * 作为 stopHvigorDaemon 之后的兜底：daemon 关闭后理论上不再有句柄，
 * 但 Windows Search / 杀毒软件仍可能短暂持有句柄，重试可覆盖这类瞬态。
 */
const RETRYABLE_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM", "EMFILE"]);

export async function removeWithRetry(
  target: string,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  } = {},
): Promise<void> {
  const maxRetries = options.maxRetries ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 1000;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !RETRYABLE_CODES.has(code) || attempt === maxRetries) {
        throw error;
      }
      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      await sleep(delay);
    }
  }
  throw lastError;
}

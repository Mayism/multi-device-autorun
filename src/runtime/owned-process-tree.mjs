import process from "node:process";

const detachedProcessGroups = new WeakSet();

export function registerOwnedProcessTree(child, { detached = false } = {}) {
  if (child && detached) detachedProcessGroups.add(child);
  return child;
}

export function signalOwnedProcessTree(child, signal = "SIGTERM", {
  platform = process.platform,
  killProcess = process.kill.bind(process),
} = {}) {
  if (!child?.pid) return false;

  if (platform !== "win32" && detachedProcessGroups.has(child)) {
    try {
      // 负 PID 表示向本次启动器创建的独立进程组发信号，确保它派生的
      // OpenCode Server 不会在启动器退出后成为孤儿进程。
      killProcess(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
      return false;
    }
  }

  if (child.exitCode !== null || child.signalCode !== null) return false;
  try {
    return child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    return false;
  }
}

import { fileURLToPath } from "node:url";
import type {
  CommandExecutor,
  CommandResult,
  DeviceConfig,
  InstallArtifacts,
  ExecutionConfig,
} from "./types/index.js";
import type { RunnerLogger } from "../logging/logger.js";
import { verifyFileExists } from "./utils/file.js";
import { shellQuote } from "./utils/shellQuote.js";
import { sleep } from "./utils/sleep.js";
import { runPythonSession, runPythonWorkerSync } from "../../../runtime/python-worker.mjs";

export interface DeviceCommandContext {
  config: ExecutionConfig;
  device: DeviceConfig;
  cwd: string;
  outDir: string;
  runCommand: (command: string) => Promise<CommandResult>;
  pollCommand?: (command: string) => Promise<CommandResult>;
  logger?: RunnerLogger;
}

export function buildStartEmulatorCommand(
  config: ExecutionConfig,
  device: DeviceConfig,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!device.profile) {
    throw new Error(`device ${device.id} has no emulator profile.`);
  }
  const args = [
    "-start",
    shellQuote(device.profile, platform),
    "-instancePath",
    shellQuote(config.paths.emulatorDeployedDir, platform),
    "-bootMode",
    device.bootMode ?? "coldboot",
    ...(device.hdcPort !== undefined
      ? ["-hdcport", String(device.hdcPort)]
      : []),
  ];
  // Windows：cmd start /min 最小化拉起。模拟器是 Qt/GLFW GUI 程序，不读取
  // STARTUPINFO 显示状态，windowsHide/SW_HIDE 均无法阻止其建窗；
  // 窗口最终由 hide-emulator-windows.ps1 彻底隐藏（见 ensureTargetReady）。
  if (platform === "win32") {
    return `start "" /min ${shellQuote(config.paths.emulatorBin, platform)} ${args.join(" ")}`;
  }
  // macOS：emulatorBin 指向 .app 包时用 open -j 隐藏启动（无需辅助功能权限）；
  // 裸二进制保持原命令，窗口由 osascript 隐藏循环兜底。darwin 分支待 Mac 实测校准。
  if (platform === "darwin" && config.paths.emulatorBin.endsWith(".app")) {
    return `open -j -a ${shellQuote(config.paths.emulatorBin, platform)} --args ${args.join(" ")}`;
  }
  return [shellQuote(config.paths.emulatorBin, platform), ...args].join(" ");
}

const hideEmulatorWindowsScript = fileURLToPath(
  new URL("./assets/hide-emulator-windows.ps1", import.meta.url),
);

// 静默启动第二步：隐藏模拟器已创建的可见窗口（等待 target 期间反复执行）。
// Windows：PowerShell 调 Win32 ShowWindow(SW_HIDE)；
// macOS：osascript 调 System Events 隐藏进程（首次需一次性辅助功能授权）；
// 其他平台返回空串（无操作）。尽力而为，失败不影响测试流程。
export function buildHideEmulatorCommand(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return [
      "powershell",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      shellQuote(hideEmulatorWindowsScript, platform, true),
    ].join(" ");
  }
  if (platform === "darwin") {
    return [
      "osascript",
      "-e",
      shellQuote(
        'tell application "System Events" to set visible of every process whose name is "Emulator" to false',
        platform,
      ),
    ].join(" ");
  }
  return "";
}

// 启动进程探测：start/open 包装后模拟器即时失败不反映到退出码，
// 探测进程是否真的出现（win32: tasklist / darwin: pgrep；其他平台返回空串）。
export function buildEmulatorProcessQueryCommand(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return 'tasklist /fo csv /nh';
  if (platform === "darwin") return 'pgrep -l -x Emulator';
  return "";
}

export function isEmulatorProcessListed(
  processListOutput: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const lines = processListOutput.split(/\r?\n/);
  if (platform === "win32") {
    return lines.some((line) => line.startsWith('"Emulator.exe'));
  }
  if (platform === "darwin") {
    return lines.some((line) => /\bEmulator\b/.test(line.trim()));
  }
  return false;
}

export function buildStopEmulatorCommand(
  config: ExecutionConfig,
  device: DeviceConfig,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!device.profile) {
    throw new Error(`device ${device.id} has no emulator profile.`);
  }
  return [
    shellQuote(config.paths.emulatorBin, platform),
    "-stop",
    shellQuote(device.profile, platform),
    "-instancePath",
    shellQuote(config.paths.emulatorDeployedDir, platform),
  ].join(" ");
}

type DeviceAction = "prepare" | "install" | "ready" | "disconnected";

async function runDeviceAction(
  action: DeviceAction,
  ctx: DeviceCommandContext,
  artifacts?: InstallArtifacts,
): Promise<unknown> {
  return runPythonSession("pyautorun.ohostest_device", {
    action,
    state: {
      hdc: ctx.config.paths.hdc,
      target: ctx.device.target,
      platform: process.platform,
      startEmulator: ctx.device.startEmulator,
      hideCommand: buildHideEmulatorCommand(),
      bundleName: ctx.config.bundleName,
      bundleNameCleanup: ctx.config.bundleNameCleanup,
    },
    artifacts,
  }, async (event: DeviceEvent) => {
    if (event.type === "command") {
      const command = event.command ?? "";
      return (event.poll ? ctx.pollCommand ?? ctx.runCommand : ctx.runCommand)(command);
    }
    if (event.type === "sleep") {
      await sleep(event.ms ?? 0);
      return null;
    }
    if (event.type === "logCommand") {
      ctx.logger?.recordCommand(event.command ?? "", event.result!);
      return null;
    }
    if (event.type === "logError") {
      ctx.logger?.recordError(new Error(event.message ?? "device_error"), {
        errorCode: event.errorCode,
        ...(event.command ? { command: event.command } : {}),
      });
      return null;
    }
    throw new Error(`未知设备事件: ${event.type}`);
  });
}

interface DeviceEvent {
  type: string;
  command?: string;
  poll?: boolean;
  ms?: number;
  result?: CommandResult;
  message?: string;
  errorCode?: string;
}

function deviceDecision(action: string, input: object): unknown {
  return JSON.parse(runPythonWorkerSync(action, input).toString("utf8"));
}

export async function prepareDevice(ctx: DeviceCommandContext): Promise<void> {
  await runDeviceAction("prepare", ctx);
}

export function parseScreenLocked(
  result: Pick<CommandResult, "stdout" | "stderr" | "exitCode">,
): boolean | undefined {
  const value = deviceDecision("ohostest-device-screen-locked", { result });
  return value === null ? undefined : Boolean(value);
}

export async function installHaps(
  ctx: DeviceCommandContext,
  artifacts: InstallArtifacts,
): Promise<void> {
  await runDeviceAction("install", ctx, artifacts);
}

export function isInstallFailure(result: CommandResult): boolean {
  return Boolean(deviceDecision("ohostest-device-install-failure", { result }));
}

export async function ensureTargetReady(ctx: DeviceCommandContext): Promise<void> {
  await runDeviceAction("ready", ctx);
}

export async function waitForTargetDisconnected(
  ctx: DeviceCommandContext,
): Promise<boolean> {
  return Boolean(await runDeviceAction("disconnected", ctx));
}

export function hdcFor(config: ExecutionConfig, device: DeviceConfig): string {
  return `${shellQuote(config.paths.hdc)} -t ${shellQuote(device.target)}`;
}

export function isTargetConnected(output: string, target: string): boolean {
  return Boolean(deviceDecision("ohostest-device-target-connected", { output, target }));
}

export async function runIfNeeded(
  commandExecutor: CommandExecutor,
  command: string,
  cwd: string,
): Promise<CommandResult> {
  return commandExecutor(command, cwd);
}

export { verifyFileExists };

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

const targetReadyMaxAttempts = 120;
// 解锁重试放宽：target 连接时锁屏服务可能尚未就绪，按键会落空；
// 5 轮 × 更长间隔覆盖慢启动设备（折叠屏实测 3 轮 15 秒不够）。
const unlockMaxAttempts = 5;
const wakeupSettleMs = 2500;
const unlockSettleMs = 2000;

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
      shellQuote(hideEmulatorWindowsScript, platform),
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

export async function prepareDevice(ctx: DeviceCommandContext): Promise<void> {
  const hdc = hdcFor(ctx.config, ctx.device);
  await ensureTargetReady(ctx);
  const deviceType = await ctx.runCommand(
    `${hdc} shell param get const.product.devicetype`,
  );
  const unlockKey =
    deviceType.exitCode === 0 &&
    deviceType.stdout.trim().toLowerCase() === "2in1"
      ? "2054"
      : "Home";
  const screenLockCommand = `${hdc} shell hidumper -s ScreenlockService -a -all`;

  for (let attempt = 0; attempt < unlockMaxAttempts; attempt += 1) {
    await ctx.runCommand(`${hdc} shell power-shell wakeup`);
    // 唤醒/按键后统一等待：亮屏与输入通路就绪需要时间，首轮立即按键容易落空
    await sleep(wakeupSettleMs);
    const key = attempt === 0 ? unlockKey : "2054";
    await ctx.runCommand(`${hdc} shell uitest uiInput keyEvent ${key}`);
    await sleep(unlockSettleMs);

    const screenLockResult = await ctx.runCommand(screenLockCommand);
    const screenLocked = parseScreenLocked(screenLockResult);
    if (screenLocked === false) return;
    // Older systems may not expose ScreenlockService. Keep the historical
    // wakeup/key-event behavior instead of rejecting a device we cannot probe.
    if (screenLocked === undefined) return;
  }

  throw new Error("device_unlock_failed");
}

export function parseScreenLocked(
  result: Pick<CommandResult, "stdout" | "stderr" | "exitCode">,
): boolean | undefined {
  if (result.exitCode !== 0) return undefined;
  const match = `${result.stdout}\n${result.stderr}`.match(
    /\bscreenLocked\s*[:=]?\s*(true|false)\b/i,
  );
  if (!match) return undefined;
  return match[1]?.toLowerCase() === "true";
}

export async function installHaps(
  ctx: DeviceCommandContext,
  artifacts: InstallArtifacts,
): Promise<void> {
  const hdc = hdcFor(ctx.config, ctx.device);
  await ctx.runCommand(`${hdc} uninstall ${shellQuote(ctx.config.bundleName)}`);
  for (const hspPath of artifacts.hspPaths) {
    await runInstallCommand(ctx, hdc, [hspPath]);
  }
  await runInstallCommand(ctx, hdc, [artifacts.appHap, artifacts.testHap]);
}

async function runInstallCommand(
  ctx: DeviceCommandContext,
  hdc: string,
  artifacts: string[],
): Promise<void> {
  const packages = artifacts.map((artifact) => shellQuote(artifact)).join(" ");
  const result = await ctx.runCommand(`${hdc} install -r ${packages}`);
  if (isInstallFailure(result)) {
    throw new Error("install_failed");
  }
}

export function isInstallFailure(result: CommandResult): boolean {
  if (result.exitCode !== 0) {
    return true;
  }
  const output = `${result.stdout}\n${result.stderr}`;
  return /msg:error:|error:\s*failed to install|failed to install the HAP or HSP/i.test(
    output,
  );
}

export async function ensureTargetReady(
  ctx: DeviceCommandContext,
): Promise<void> {
  let lastResult: CommandResult | undefined;
  const command = `${shellQuote(ctx.config.paths.hdc)} list targets`;
  for (let attempt = 0; attempt < targetReadyMaxAttempts; attempt += 1) {
    const result = await (ctx.pollCommand ?? ctx.runCommand)(command);
    lastResult = result;
    if (isTargetConnected(result.stdout, ctx.device.target)) {
      ctx.logger?.recordCommand(command, result);
      return;
    }
    await hideStartedEmulatorWindow(ctx);
    await sleep(1000);
  }
  if (lastResult) ctx.logger?.recordCommand(command, lastResult);
  throw new Error("hdc_not_connected");
}

// 模拟器窗口在设备引导过程中才创建；等待 hdc target 就绪期间反复尝试隐藏。
// 尽力而为：隐藏失败不影响测试流程；仅对本 Runner 启动的模拟器（startEmulator）生效，
// 避免误藏用户手动打开、正在观察的模拟器窗口。
async function hideStartedEmulatorWindow(
  ctx: DeviceCommandContext,
): Promise<void> {
  if (!ctx.device.startEmulator) return;
  const command = buildHideEmulatorCommand();
  if (!command) return;
  try {
    await (ctx.pollCommand ?? ctx.runCommand)(command);
  } catch {
    // 隐藏失败不阻断等待流程
  }
}

export async function waitForTargetDisconnected(
  ctx: DeviceCommandContext,
): Promise<boolean> {
  let lastResult: CommandResult | undefined;
  const command = `${shellQuote(ctx.config.paths.hdc)} list targets`;
  for (let attempt = 0; attempt < targetReadyMaxAttempts; attempt += 1) {
    const result = await (ctx.pollCommand ?? ctx.runCommand)(command);
    lastResult = result;
    if (!isTargetConnected(result.stdout, ctx.device.target)) {
      ctx.logger?.recordCommand(command, result);
      return true;
    }
    await sleep(1000);
  }
  if (lastResult) ctx.logger?.recordCommand(command, lastResult);
  ctx.logger?.recordError(new Error("hdc_disconnect_timeout"), {
    errorCode: "HDC_DISCONNECT_TIMEOUT",
    command,
  });
  return false;
}

export function hdcFor(config: ExecutionConfig, device: DeviceConfig): string {
  return `${shellQuote(config.paths.hdc)} -t ${shellQuote(device.target)}`;
}

export function isTargetConnected(output: string, target: string): boolean {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line.startsWith(target) && !/\bOffline\b/i.test(line));
}

export async function runIfNeeded(
  commandExecutor: CommandExecutor,
  command: string,
  cwd: string,
): Promise<CommandResult> {
  return commandExecutor(command, cwd);
}

export { verifyFileExists };

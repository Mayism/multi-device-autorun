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
const unlockMaxAttempts = 3;
const wakeupSettleMs = 1500;
const unlockSettleMs = 1000;

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
  return [
    shellQuote(config.paths.emulatorBin, platform),
    "-start",
    shellQuote(device.profile, platform),
    "-instancePath",
    shellQuote(config.paths.emulatorDeployedDir, platform),
    ...(device.hdcPort !== undefined
      ? ["-hdcport", String(device.hdcPort)]
      : []),
  ].join(" ");
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
    if (attempt > 0) await sleep(wakeupSettleMs);
    const key = attempt === 0 ? unlockKey : "2054";
    await ctx.runCommand(`${hdc} shell uitest uiInput keyEvent ${key}`);
    if (attempt > 0) await sleep(unlockSettleMs);

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
    await sleep(1000);
  }
  if (lastResult) ctx.logger?.recordCommand(command, lastResult);
  throw new Error("hdc_not_connected");
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

// testEmulatorStartup.ts
// 单独验证模拟器静默启动：不执行用例，只走"启动 → 等待 hdc target → 窗口探测/隐藏 → 停止"
// 与 Runner 完全相同的命令路径（复用 device.ts 的命令构造），用于排查模拟器环节问题。
//
// 用法:
//   node --import tsx scripts/testEmulatorStartup.ts --profile "Pura 90 Pro Max" --hdcport 15001
// 可选:
//   --emulator-bin <path>    默认 D:/Program Files/Huawei/DevEco Studio/tools/emulator/Emulator.exe
//   --instance-path <dir>    默认 D:/emulator
//   --hdc <path>             默认 DevEco sdk toolchains 下的 hdc.exe
//   --keep                   结束后不停模拟器（配合 -hdcport 复现场景）
//   --timeout-sec <n>        等待 target 的超时，默认 300

import { spawn } from "node:child_process";
import path from "node:path";
import {
  buildHideEmulatorWindowsCommand,
  buildStartEmulatorCommand,
  buildStopEmulatorCommand,
} from "../src/execution/device.js";
import type { DeviceConfig, ExecutionConfig } from "../src/execution/types/index.js";
import { sleep } from "../src/execution/utils/sleep.js";

const DEVECO_HOME = "D:/Program Files/Huawei/DevEco Studio";

function parse(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key.slice(2)] = next;
      i += 1;
    } else {
      out[key.slice(2)] = true;
    }
  }
  return out;
}

const args = parse(process.argv.slice(2));
const profile = String(args.profile ?? "");
const hdcPort = Number(args.hdcport ?? 0);
if (!profile || !hdcPort) {
  console.error(
    '用法: node --import tsx scripts/testEmulatorStartup.ts --profile "Pura 90 Pro Max" --hdcport 15001',
  );
  process.exit(1);
}

const config = {
  paths: {
    emulatorBin: String(
      args["emulator-bin"] ?? `${DEVECO_HOME}/tools/emulator/Emulator.exe`,
    ),
    emulatorDeployedDir: String(args["instance-path"] ?? "D:/emulator"),
    hdc: String(
      args.hdc ??
        `${DEVECO_HOME}/sdk/default/openharmony/toolchains/hdc.exe`,
    ),
  },
} as Pick<ExecutionConfig, "paths"> as ExecutionConfig;
const device = {
  id: profile,
  profile,
  target: `127.0.0.1:${hdcPort}`,
  hdcPort,
  startEmulator: true,
} as DeviceConfig;

function run(command: string, timeoutMs = 15000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    // 注意：Windows 下 detached+shell 会破坏 stdout 捕获（探测全部失明），
    // 模拟器本身由 cmd start 脱离，这里无需 detached。
    const child = spawn(command, {
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve({ code: 0, out, err });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk;
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, out, err });
    });
  });
}

// 进程探测用 tasklist 解析（经 cmd 调用时比 PowerShell 标量输出稳定可靠）；
// 窗口句柄探测用 @() 包裹保证单进程时也输出数组。
const processCountCommand = 'tasklist /fo csv /nh';
const windowProbeCommand =
  'powershell -NoProfile -Command "@(Get-Process -Name Emulator -ErrorAction SilentlyContinue) | ForEach-Object { \\"{0}:{1}\\" -f $_.Id, $_.MainWindowHandle }"';

async function emulatorProcessCount(): Promise<number> {
  const result = await run(processCountCommand);
  return result.out
    .split(/\r?\n/)
    .filter((line) => line.startsWith('"Emulator.exe')).length;
}

const startedAt = Date.now();
console.log("[1/4] 启动命令:");
console.log("      " + buildStartEmulatorCommand(config, device));
const startResult = await run(buildStartEmulatorCommand(config, device));
console.log(`      exit=${startResult.code} ${(Date.now() - startedAt) / 1000 | 0}s ${startResult.out.trim()}`);

const timeoutSec = Number(args["timeout-sec"] ?? 300);
const hideCommand = buildHideEmulatorWindowsCommand();
let windowSeen = false;
let hiddenCount = 0;
let connected = false;

console.log("[2/4] 等待 hdc target 就绪（期间持续探测/隐藏窗口）...");
let round = 0;
while (Date.now() - startedAt < timeoutSec * 1000) {
  const processCount = await emulatorProcessCount();
  const probe = await run(windowProbeCommand);
  const handles = probe.out
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.includes(":"));
  if (handles.length && handles.some((line) => line.split(":")[1] !== "0")) {
    windowSeen = true;
  }
  if (hideCommand) {
    const hide = await run(hideCommand);
    hiddenCount += parseInt(hide.out.trim(), 10) || 0;
  }
  const hdc = await run(`"${config.paths.hdc}" list targets`, 8000);
  if (hdc.out.includes(device.target)) {
    connected = true;
    break;
  }
  round += 1;
  if (round % 10 === 0) {
    const elapsedNow = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(
      `      ... ${elapsedNow}s: Emulator 进程 ${processCount} 个，target 未连接`,
    );
  }
  await sleep(3000);
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
console.log(
  `[3/4] 结果: target${connected ? "已连接" : "未连接"}（${elapsed}s），` +
    `窗口${windowSeen ? "出现过（已隐藏 " + hiddenCount + " 次）" : "未出现（天然无窗）"}`,
);

if (args.keep) {
  console.log("[4/4] --keep：模拟器保持运行");
} else {
  const stop = await run(buildStopEmulatorCommand(config, device), 30000);
  console.log(`[4/4] 停止模拟器: exit=${stop.code} ${stop.out.trim()}`);
}
process.exit(connected ? 0 : 1);

#!/usr/bin/env node
// run-opencode-serve.mjs
// 直接启动 opencode serve（仅启动 opencode 二进制，不含 harmony-acp）。
// 与 plugin-cli/run-opencode-serve.{bat,sh} 功能、参数一致；Node.js 版本的好处：
//   - 跨平台：同一脚本在 Windows / macOS / Linux 上跑，自动挑对二进制；
//   - 不依赖 PowerShell 取时间戳；
//   - spawn 透传 stdio，子进程 Ctrl-C 由父进程原样转发，与 .bat/.sh 行为一致。
//
// 用法：
//   node src/run-opencode-serve.mjs --source D:\bundle\resources\opencode
//   node src/run-opencode-serve.mjs --source D:\bundle\resources\opencode --port 62000
//   node src/run-opencode-serve.mjs --root D:\bundle --workspace D:\proj
//
// --source 直接指向 resources/opencode；--root 保留为资源包根目录入口：
//   bundled:   $ROOT/resources/opencode/{bin/<platform>/<arch>/opencode[.exe],
//                                        opencode.json, plugin/, skills/}
//   运行时:    ~/.harmonybot/opencode/vscode/{data,xdg-config,state,cache,config}
//              ~/.harmonybot/logs/vscode/runs/<runId>
//
// 运行时路径对齐 src/shared/harmonybotOpencodeRuntimeEnv.ts（host=vscode，无
// worker）与 src/shared/harmonybotRunLog.ts。
// OPENCODE_CONFIG_DIR 直接指向选中来源的 resources/opencode，不复制配置和资源。
// harmonyBot 可包含 agent/plugin/skills/provider；softwareEngineering 允许只配置
// skills（以及启动所需的 bin/opencode.json）。auth / DB、状态和缓存仍落运行时目录。
//
// 可调参数（CLI 优先于环境变量）：
//   --port, -p N           监听端口 (env: PORT, 默认 61417)
//   --source PATH          resources/opencode 目录 (env: OPENCODE_SOURCE)
//   --runtime-root PATH    OpenCode 运行数据目录 (env: OPENCODE_RUNTIME_ROOT)
//   --root, -r PATH        资源包根目录，读取其 resources/opencode
//   --config, -c PATH      --root 的别名
//   --workspace, -w PATH   工作目录 (env: WORKSPACE, 默认 $PWD)
//   --deveco-home, -d PATH DevEco Studio 安装根
//                           Windows: C:\Program Files\Huawei\DevEco Studio
//                           macOS:   /Applications/DevEco-Studio.app
//                           (env: DEVECO_HOME)
//   -h, --help             帮助

import process from 'node:process';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const HELP = [
  '用法: node src/run-opencode-serve.mjs [--port N] [--source PATH]',
  '                                  [--runtime-root PATH] [--root PATH]',
  '                                  [--workspace PATH] [--deveco-home PATH]',
  '                                  [--help]',
  '',
  '启动 opencode serve。CLI 优先于环境变量。',
  '  --port, -p N           监听端口 (默认 61417, env: PORT)',
  '  --source PATH          resources/opencode 目录 (env: OPENCODE_SOURCE)',
  '  --runtime-root PATH    OpenCode 运行数据目录 (env: OPENCODE_RUNTIME_ROOT)',
  '  --root, -r PATH        资源包根目录，读取其 resources/opencode (env: ROOT)',
  '  --config, -c PATH      --root 的别名',
  '  --workspace, -w PATH   工作目录 (默认 $PWD, env: WORKSPACE)',
  '  --deveco-home, -d PATH DevEco Studio 安装根',
  '                          (Windows 默认 "C:\\Program Files\\Huawei\\DevEco Studio",',
  '                           macOS 默认 /Applications/DevEco-Studio.app, env: DEVECO_HOME)',
  '  --help, -h             显示此帮助',
  '',
  '示例:',
  '  node src/run-opencode-serve.mjs --source D:\\bundle\\resources\\opencode --port 62000',
  '  node src/run-opencode-serve.mjs --root D:\\bundle --workspace D:\\proj',
].join('\n');

const out = (s) => process.stdout.write(s + '\n');
const err = (s) => process.stderr.write(s + '\n');

// ─── 平台相关默认值 ──────────────────────────────────────────────
// 与 .bat（Windows 默认）/ .sh（macOS 默认）行为一致；其它平台给出最接近的值。
const PLATFORM_DEFAULTS = {
  win32: {
    arch: { x64: 'win32/x64', arm64: 'win32/arm64' },
    binaryExt: '.exe',
    devecoHome: 'C:\\Program Files\\Huawei\\DevEco Studio',
    devecoContentsSubdir: '',          // Windows: 安装根本身就是 Contents
    jbrSubdir: 'jbr',                  // JAVA_HOME 直接指向 jbr
    nodeBin: 'tools\\node',            // PATH 用 ; 分隔；此处仅作为拼接提示
  },
  darwin: {
    arch: { arm64: 'darwin/arm64', x64: 'darwin/x64' },
    binaryExt: '',
    devecoHome: '/Applications/DevEco-Studio.app',
    devecoContentsSubdir: '/Contents',
    jbrSubdir: 'jbr/Contents/Home',
    nodeBin: 'tools/node/bin',
  },
  linux: {
    arch: { x64: 'linux/x64', arm64: 'linux/arm64' },
    binaryExt: '',
    // Linux 上没有官方 DevEco Studio；用户可通过 --deveco-home 覆盖。
    devecoHome: '/opt/deveco-studio',
    devecoContentsSubdir: '',
    jbrSubdir: 'jbr',
    nodeBin: 'tools/node/bin',
  },
};

function platformDefaults() {
  const pf = process.platform;
  const arch = process.arch;
  const table = PLATFORM_DEFAULTS[pf];
  if (!table) {
    throw new Error(`不支持的平台: ${pf}/${arch}`);
  }
  const binDir = table.arch[arch];
  if (!binDir) {
    throw new Error(`不支持的架构: ${pf}/${arch}`);
  }
  return { ...table, binDir, platform: pf, arch };
}

const PATH_SEP = process.platform === 'win32' ? ';' : ':';

// ─── CLI 参数解析（CLI 优先，env 作为兜底；与 .bat/.sh 行为一致）───
function parseArgs(argv) {
  const opts = {
    port: process.env.PORT || '',
    root: process.env.ROOT || '',
    source: process.env.OPENCODE_SOURCE || '',
    runtimeRoot: process.env.OPENCODE_RUNTIME_ROOT || '',
    workspace: process.env.WORKSPACE || '',
    devecoHome: process.env.DEVECO_HOME || '',
  };

  const needValue = (flag) => {
    err(`[error] ${flag} 需要一个值`);
    process.exit(2);
  };

  const a = argv.slice(2);
  const takeTwo = (i, flag) => {
    if (a[i + 1] === undefined) needValue(flag);
    return a[++i];
  };

  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    switch (v) {
      case '-h':
      case '--help':
        out(HELP);
        process.exit(0);
        break;
      case '--port':
      case '-p':
        opts.port = takeTwo(i, v); i++;
        break;
      case '--root':
      case '-r':
      case '--config':
      case '-c':
        opts.root = takeTwo(i, v); i++;
        break;
      case '--source':
        opts.source = takeTwo(i, v); i++;
        break;
      case '--runtime-root':
        opts.runtimeRoot = takeTwo(i, v); i++;
        break;
      case '--workspace':
      case '-w':
        opts.workspace = takeTwo(i, v); i++;
        break;
      case '--deveco-home':
      case '-d':
        opts.devecoHome = takeTwo(i, v); i++;
        break;
      default:
        if (v.startsWith('-')) {
          err(`[error] 未知选项: ${v}`);
          process.exit(2);
        }
        err(`[error] 不支持位置参数: ${v}（请用 --root / --workspace 等）`);
        process.exit(2);
    }
  }
  return opts;
}

// ─── 时间戳：yyyyMMddTHHmmss（不依赖 PowerShell）────────────────
function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    'T' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

// ─── 主流程 ────────────────────────────────────────────────────
const opts = parseArgs(process.argv);
const defaults = platformDefaults();

const cwd = process.cwd();
const workspace = opts.workspace || cwd;
const configDir = process.env.CONFIG_DIR || path.join(cwd, 'config');
const root = opts.root || configDir;
const port = opts.port || '61417';

const bundledConfigDir = path.resolve(opts.source || path.join(root, 'resources', 'opencode'));
const opencodeBin = path.join(bundledConfigDir, 'bin', defaults.binDir, 'opencode' + defaults.binaryExt);
const devecoHome = opts.devecoHome || defaults.devecoHome;

// 运行时路径与 vscode 扩展一致，落在 ~/.harmonybot 下（host=vscode，无 worker）：
//   ~/.harmonybot/opencode/vscode/{data,xdg-config,state,cache,config}
//   ~/.harmonybot/logs/vscode/runs/<runId>
// 对齐 src/shared/harmonybotOpencodeRuntimeEnv.ts、harmonybotRunLog.ts。
const harmonybotHome = path.join(os.homedir(), '.harmonybot');
const opencodeHostRoot = path.resolve(opts.runtimeRoot || path.join(harmonybotHome, 'opencode', 'vscode'));
const logRoot = opts.runtimeRoot ? path.join(opencodeHostRoot, 'logs') : path.join(harmonybotHome, 'logs');
const runId = `${timestamp()}-${randomBytes(3).toString('hex')}`;
const logDir = opts.runtimeRoot
  ? path.join(logRoot, 'runs', runId)
  : path.join(logRoot, 'vscode', 'runs', runId);

// ─── 前置检查 ──────────────────────────────────────────────────
if (!existsSync(opencodeBin)) {
  err(`[error] 找不到 opencode 二进制: ${opencodeBin}`);
  err(`        期望路径: <source>/bin/${defaults.binDir}/opencode${defaults.binaryExt}`);
  err('        可通过 --source 或 --root 覆盖');
  process.exit(1);
}
if (!existsSync(workspace)) {
  err(`[error] workspace 不存在: ${workspace}`);
  process.exit(1);
}
if (!existsSync(devecoHome)) {
  err(`[error] DEVECO_HOME 不存在: ${devecoHome}`);
  err(`        可通过 --deveco-home 或 DEVECO_HOME= 覆盖`);
  process.exit(1);
}

// ─── DevEco 派生路径 ───────────────────────────────────────────
// macOS: 用户可能传 .app 包；取其 Contents。等同 .sh 的行为。
// Windows / Linux: 安装根即 Contents。
const devecoContents = existsSync(path.join(devecoHome, 'Contents'))
  ? path.join(devecoHome, 'Contents')
  : devecoHome;

const javaHome = process.env.JAVA_HOME || path.join(devecoContents, defaults.jbrSubdir);
const toolHome = process.env.TOOL_HOME || devecoContents;
const devecoSdkHome = process.env.DEVECO_SDK_HOME || path.join(devecoContents, 'sdk');
const hosSdkHome = process.env.HOS_SDK_HOME || devecoSdkHome;
const ohosSdkHome = process.env.OHOS_SDK_HOME || devecoSdkHome;

// DevEco 工具链 PATH（bin/node/ohpm/hvigor + SDK toolchains）
const devecoPath = [
  path.join(javaHome, 'bin'),
  path.join(devecoContents, defaults.nodeBin),
  path.join(devecoContents, 'tools', 'ohpm', 'bin'),
  path.join(devecoContents, 'tools', 'hvigor', 'bin'),
  path.join(devecoSdkHome, 'default', 'openharmony', 'toolchains'),
].join(PATH_SEP);

// 插件 CLI（pluginFetch linkBin:true 写入的 wrapper），与扩展 prependPluginBinToPath 一致。
const pluginBinDir = path.join(bundledConfigDir, 'plugin', '.bin');
const agentPath = existsSync(pluginBinDir)
  ? [pluginBinDir, devecoPath, process.env.PATH || ''].join(PATH_SEP)
  : [devecoPath, process.env.PATH || ''].join(PATH_SEP);

// ─── 创建运行期目录（mkdir -p，错误即吞，与 .bat 的 2>nul 一致）──
// 与 vscode 扩展 ensureRuntimeDirs + createRunContext 对齐：运行数据与来源配置分离。
for (const d of [
  logDir,
  path.join(opencodeHostRoot, 'data'),
  path.join(opencodeHostRoot, 'xdg-config'),
  path.join(opencodeHostRoot, 'state'),
  path.join(opencodeHostRoot, 'cache'),
]) {
  mkdirSync(d, { recursive: true });
}

// ─── 打印启动摘要 ──────────────────────────────────────────────
out('[run] source:           ' + bundledConfigDir);
out('[run] opencode binary:  ' + opencodeBin);
out('[run] workspace:        ' + workspace);
out('[run] config source:    ' + bundledConfigDir);
out('[run] opencode host:    ' + opencodeHostRoot);
out('[run] config dir:       ' + bundledConfigDir + '  (OPENCODE_CONFIG_DIR, direct)');
out('[run] deveco home:      ' + devecoContents);
out('[run] port:             ' + port);
out('[run] log root:         ' + logRoot);
out('[run] log dir:          ' + logDir);
out('');

// ─── 构造子进程环境（与 .bat/.sh 的 env 列表一致）────────────────
// 与 .bat/.sh 不同：这里显式不复制 OPENCODE_CONFIG / OPENCODE_CONFIG_CONTENT /
// OPENCODE_AUTH_CONTENT，相当于 `set "X="` 置空。Node 中通过 delete 即可。
const env = { ...process.env };
delete env.OPENCODE_CONFIG;
delete env.OPENCODE_CONFIG_CONTENT;
delete env.OPENCODE_AUTH_CONTENT;
delete env.OPENCODE_BUNDLED_CONFIG_DIR;

Object.assign(env, {
  OPENCODE_CLIENT: 'harmonybot-vscode',
  OPENCODE_ENABLE_QUESTION_TOOL: 'true',
  XDG_DATA_HOME: path.join(opencodeHostRoot, 'data'),
  XDG_CONFIG_HOME: path.join(opencodeHostRoot, 'xdg-config'),
  XDG_STATE_HOME: path.join(opencodeHostRoot, 'state'),
  XDG_CACHE_HOME: path.join(opencodeHostRoot, 'cache'),
  OPENCODE_DB: 'opencode-harmonybot.db',
  OPENCODE_CONFIG_DIR: bundledConfigDir,
  OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
  OPENCODE_DISABLE_AUTOUPDATE: 'true',
  JAVA_HOME: javaHome,
  PATH: agentPath,
  TOOL_HOME: toolHome,
  DEVECO_HOME: devecoContents,
  DEVECO_SDK_HOME: devecoSdkHome,
  HOS_SDK_HOME: hosSdkHome,
  OHOS_SDK_HOME: ohosSdkHome,
  HARMONYBOT_DEVECO_INSTALL_PATH: devecoContents,
  HARMONYBOT_LOG_ROOT: logRoot,
  HARMONYBOT_IDE_HOST: 'vscode',
  HARMONYBOT_RUN_ID: runId,
  HARMONYBOT_IDE_LOG_DIR: logDir,
  HARMONYBOT_LOG_LEVEL: 'info',
  OPENCODE_RUN_ID: runId,
  OPENCODE_LOG_DIR: logDir,
  HM_PLUGIN_LOG_DIR: logDir,
});

// ─── 启动 opencode serve（stdio 透传；Ctrl-C 由父进程原样转发）──
const child = spawn(opencodeBin, ['serve', '--port', port], {
  cwd: workspace,
  env,
  stdio: 'inherit',
  windowsHide: true,
});

child.on('error', (e) => {
  err(`[error] 启动 opencode 失败: ${e.message}`);
  process.exit(1);
});

let shutdownRequested = false;

function requestChildShutdown(signal = 'SIGTERM') {
  if (shutdownRequested) return;
  shutdownRequested = true;
  if (!child.killed) child.kill(signal);
}

// 透传退出码：opencode 怎么退，本脚本就怎么退
child.on('exit', (code, signal) => {
  if (shutdownRequested) {
    process.exit(code ?? 0);
  }
  if (signal) {
    // Ctrl-C / kill：尊重信号，不强行改 exit code
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

// 父进程收到 Ctrl-C 时，转发给子进程，避免留下孤儿
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    requestChildShutdown(sig);
  });
}

process.on('message', (message) => {
  if (message?.type === 'autorun:shutdown') {
    requestChildShutdown('SIGTERM');
  }
});

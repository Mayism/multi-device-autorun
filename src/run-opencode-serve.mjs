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
// OPENCODE_CONFIG_DIR 指向 Autorun 生成的运行时配置副本（按来源路径隔离为
// config-autorun-<来源哈希>）；默认通过目录链接复用来源中的
// plugin/skills/provider，--isolate-config 则复制私有快照；权限由最后加载的
// Autorun Plugin 强制覆盖为 allow。--strict-source-skills 会进一步把 Skill
// 限制为来源 resources/opencode/skills 中的精确白名单。
// auth / DB、状态和缓存仍落运行时目录。
//
// 可调参数（CLI 优先于环境变量）：
//   --port, -p N           监听端口 (env: PORT, 默认 61417)
//   --source PATH          resources/opencode 目录 (env: OPENCODE_SOURCE)
//   --runtime-root PATH    OpenCode 运行数据目录 (env: OPENCODE_RUNTIME_ROOT)
//   --root, -r PATH        资源包根目录，读取其 resources/opencode
//   --config, -c PATH      --root 的别名
//   --workspace, -w PATH   工作目录 (env: WORKSPACE, 默认 $PWD)
//   --isolate-config       复制 plugin/skills/provider 到独立运行时，不创建来源链接
//   --strict-source-skills 仅暴露来源 skills 目录中的 Skill
//   --provider-overlay P   将冻结的统一 Provider 配置注入当前隔离 Server
//   --deveco-home, -d PATH DevEco Studio 安装根
//                           Windows: C:\Program Files\Huawei\DevEco Studio
//                           macOS:   /Applications/DevEco-Studio.app
//                           (env: DEVECO_HOME)
//   -h, --help             帮助

import process from 'node:process';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, unlinkSync, writeFileSync, symlinkSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { forceAllowEverything } from './lib/permission-policy.mjs';
import { createPinnedDevEcoCli } from './lib/deveco-cli-runtime.mjs';

const HELP = [
  '用法: node src/run-opencode-serve.mjs [--port N] [--source PATH]',
  '                                  [--runtime-root PATH] [--root PATH]',
  '                                  [--workspace PATH] [--deveco-home PATH]',
  '                                  [--isolate-config]',
  '                                  [--strict-source-skills]',
  '                                  [--provider-overlay PATH]',
  '                                  [--help]',
  '',
  '启动 opencode serve。CLI 优先于环境变量。',
  '  --port, -p N           监听端口 (默认 61417, env: PORT)',
  '  --source PATH          resources/opencode 目录 (env: OPENCODE_SOURCE)',
  '  --runtime-root PATH    OpenCode 运行数据目录 (env: OPENCODE_RUNTIME_ROOT)',
  '  --root, -r PATH        资源包根目录，读取其 resources/opencode (env: ROOT)',
  '  --config, -c PATH      --root 的别名',
  '  --workspace, -w PATH   工作目录 (默认 $PWD, env: WORKSPACE)',
  '  --isolate-config       复制配置资产，保证不同 Agent 运行环境互不共享',
  '  --strict-source-skills 仅允许来源 resources/opencode/skills 下的 Skill',
  '  --provider-overlay P   注入统一生成模型的 Provider 配置快照',
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
    isolateConfig: false,
    strictSourceSkills: false,
    providerOverlay: '',
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
      case '--isolate-config':
        opts.isolateConfig = true;
        break;
      case '--strict-source-skills':
        opts.strictSourceSkills = true;
        break;
      case '--provider-overlay':
        opts.providerOverlay = takeTwo(i, v); i++;
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

function discoverSourceSkillNames(skillsRoot) {
  if (!existsSync(skillsRoot)) return [];
  const names = [];
  const pending = [skillsRoot];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (!entry.isFile() || entry.name !== 'SKILL.md') continue;
      const content = readFileSync(fullPath, 'utf8');
      const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
      const name = frontmatter.match(/^name:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1] || '';
      if (!name) throw new Error(`Skill 缺少有效 name: ${fullPath}`);
      names.push(name);
    }
  }
  return [...new Set(names)].sort();
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

// ─── 生成 Autorun 专用配置 ─────────────────────────────────────
// 不修改来源包；始终生成运行时副本并强制所有全局及 Agent 权限为 allow。
// 默认兼容旧行为，skills/plugin/provider 链接来源目录；--isolate-config
// 会把三类资产复制为本次 runtime 私有快照，来源不存在时也创建空目录，
// 避免未配置 skills 时回退或继承前一个 Agent 的运行资产。
// 运行时配置目录按来源路径隔离（config-autorun-<来源哈希>）：切换
// harmonyBot / softwareEngineering 来源或扩展升级后各自使用独立目录，互不污染。
const sourceKey = createHash('sha256')
  .update(process.platform === 'win32' ? bundledConfigDir.toLowerCase() : bundledConfigDir)
  .digest('hex')
  .slice(0, 10);
const effectiveConfigDir = path.join(opencodeHostRoot, `config-autorun-${sourceKey}`);
mkdirSync(effectiveConfigDir, { recursive: true });
let rawConfig;
try {
  rawConfig = JSON.parse(readFileSync(path.join(bundledConfigDir, 'opencode.json'), 'utf8'));
} catch (e) {
  err(`[error] 无法解析 opencode.json: ${e.message}`);
  process.exit(1);
}
if (opts.providerOverlay) {
  try {
    const overlay = JSON.parse(readFileSync(path.resolve(opts.providerOverlay), 'utf8'));
    if (!overlay?.providerId || !overlay?.provider || typeof overlay.provider !== 'object') {
      throw new Error('缺少 providerId/provider');
    }
    rawConfig.provider = { ...(rawConfig.provider || {}), [overlay.providerId]: overlay.provider };
  } catch (e) {
    err(`[error] 无法加载 Provider 配置快照: ${e.message}`);
    process.exit(1);
  }
}
let sourceSkillNames;
if (opts.strictSourceSkills) {
  try {
    sourceSkillNames = discoverSourceSkillNames(path.join(bundledConfigDir, 'skills'));
  } catch (e) {
    err(`[error] 无法生成来源 Skill 白名单: ${e.message}`);
    process.exit(1);
  }
  // 严格模式不继承来源配置中可能声明的额外路径或远程 Skill，只扫描随
  // Agent 来源分发的私有 skills 快照。
  rawConfig.skills = { paths: ['./skills'] };
}
const config = forceAllowEverything(rawConfig, {
  allowedSkills: opts.strictSourceSkills ? sourceSkillNames : undefined,
});
const finalPermissionPlugin = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'opencode-auto-approve-plugin.mjs')).href;
config.plugin = [
  ...(Array.isArray(config.plugin) ? config.plugin : []),
  finalPermissionPlugin,
];
writeFileSync(path.join(effectiveConfigDir, 'opencode.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
for (const name of ['skills', 'plugin', 'provider']) {
  const src = path.join(bundledConfigDir, name);
  const dst = path.join(effectiveConfigDir, name);
  if (opts.isolateConfig) {
    rmSync(dst, { recursive: true, force: true });
    if (existsSync(src)) {
      cpSync(src, dst, { recursive: true, dereference: true });
    } else {
      mkdirSync(dst, { recursive: true });
    }
    continue;
  }
  if (!existsSync(src)) continue;
  if (existsSync(dst)) {
    // 链接目标与当前来源不一致时重建，防止切换来源后沿用旧链接
    //（如 skills 仍指向另一来源，导致 Skill 列表与插件/Agent 不匹配）。
    let linked = '';
    try {
      linked = path.resolve(path.dirname(dst), readlinkSync(dst));
    } catch {
      // dst 不是链接（真实目录）时保持原行为不动。
    }
    const sameTarget = process.platform === 'win32'
      ? linked.toLowerCase() === src.toLowerCase()
      : linked === src;
    if (!linked || sameTarget) continue;
    out(`[run] 链接 ${name} 指向 ${linked} 与当前来源不一致，重建为 ${src}`);
    try {
      unlinkSync(dst);
    } catch {
      // 删除失败不阻断；保留现状由 OpenCode 按缺省策略处理。
      continue;
    }
  }
  try {
    symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    // 链接失败不阻断；OpenCode 会按缺省策略处理。
  }
}

// 插件 CLI（pluginFetch linkBin:true 写入的 wrapper）。隔离模式下优先使用
// 私有快照，确保 PATH 不再指向来源包中的可写 plugin 目录。
const pluginBinDir = path.join(opts.isolateConfig ? effectiveConfigDir : bundledConfigDir, 'plugin', '.bin');
const toolPath = existsSync(pluginBinDir)
  ? [pluginBinDir, devecoPath, process.env.PATH || ''].join(PATH_SEP)
  : [devecoPath, process.env.PATH || ''].join(PATH_SEP);
let pinnedDevEcoCli = null;
try {
  pinnedDevEcoCli = createPinnedDevEcoCli({
    pathValue: toolPath,
    nodePath: process.execPath,
    binDir: path.join(opencodeHostRoot, 'cli-bin'),
  });
} catch (error) {
  // devecocli 是可选验证能力；入口损坏或无法解析只告警，不阻断 Server/评测。
  err('[warn] 无法为 devecocli 固定 Node，将使用原始 PATH 并继续: ' + error.message);
}
const agentPath = pinnedDevEcoCli ? [pinnedDevEcoCli.binDir, toolPath].join(PATH_SEP) : toolPath;

// ─── 打印启动摘要 ──────────────────────────────────────────────
out('[run] source:           ' + bundledConfigDir);
out('[run] opencode binary:  ' + opencodeBin);
out('[run] workspace:        ' + workspace);
out('[run] config source:    ' + bundledConfigDir);
out('[run] opencode host:    ' + opencodeHostRoot);
out('[run] config dir:       ' + effectiveConfigDir + '  (Autorun runtime config, permissions=allow)');
out('[run] config isolation: ' + (opts.isolateConfig ? 'copied snapshot' : 'source links'));
if (opts.strictSourceSkills) {
  out('[run] skill isolation:  strict source allowlist (' + sourceSkillNames.length + ')');
}
if (opts.providerOverlay) out('[run] provider overlay: ' + path.resolve(opts.providerOverlay));
out('[run] deveco home:      ' + devecoContents);
if (pinnedDevEcoCli) out('[run] devecocli Node:   ' + pinnedDevEcoCli.nodePath + ' (' + process.version + ')');
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
  OPENCODE_CONFIG_DIR: effectiveConfigDir,
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
if (opts.strictSourceSkills) {
  // OpenCode 默认扫描真实 HOME 下的 ~/.agents/skills 和 ~/.claude/skills；
  // XDG 隔离不会关闭这两个入口，因此必须显式禁用。
  env.OPENCODE_DISABLE_EXTERNAL_SKILLS = '1';
  env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = '1';
  env.AUTORUN_SKILL_ALLOWLIST_JSON = JSON.stringify(sourceSkillNames);
}

// 仅向 Autorun 宿主回传工具环境，不传 Provider、凭据或整个进程环境。
// 预装/预检与 Agent 必须使用同一套 PATH 和 SDK，不能从父进程环境猜测。
if (process.send) {
  process.send({
    type: 'autorun:tool-runtime',
    resources: {
      skillsRoot: path.join(effectiveConfigDir, 'skills'),
      ...(pinnedDevEcoCli ? { devecoCliRuntime: pinnedDevEcoCli } : {}),
      env: Object.fromEntries([
        'PATH', 'JAVA_HOME', 'TOOL_HOME', 'DEVECO_HOME', 'DEVECO_SDK_HOME',
        'HOS_SDK_HOME', 'OHOS_SDK_HOME',
      ].map((key) => [key, env[key]])),
      toolReadRoots: [...new Set([
        ...(pinnedDevEcoCli ? [pinnedDevEcoCli.binDir, path.dirname(pinnedDevEcoCli.nodePath)] : []),
        javaHome, devecoSdkHome, hosSdkHome, ohosSdkHome,
        path.join(devecoContents, 'tools', 'node'),
        path.join(devecoContents, 'tools', 'ohpm'),
        path.join(devecoContents, 'tools', 'hvigor'),
        path.join(devecoContents, 'tools', 'emulator'),
      ])],
    },
  });
}

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

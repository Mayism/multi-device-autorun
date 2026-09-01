import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectDevEcoCli, formatDevEcoCliFailure } from "../platform/deveco-cli.mjs";

const execute = promisify(execFile);
const ONE_MULTI_NAME = "harmonyos-ui-multi";
const ONE_MULTI_INSTALLER = "scripts/install-to-project.py";

function isInside(root, target) {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

async function regularPathInside(root, target) {
  const realRoot = await fs.realpath(root);
  const realTarget = await fs.realpath(target);
  if (!isInside(realRoot, realTarget)) throw new Error(`Skill 资源越出授权目录: ${target}`);
  return realTarget;
}

// 只从本次来源的私有快照发现资源；全局安装但不属于来源的 Skill 不扩展白名单。
export async function discoverRuntimeSkills(skillsRoot, registeredSkills) {
  const root = await fs.realpath(skillsRoot);
  const names = new Set(registeredSkills.map((item) => String(item?.name || item?.id || item)));
  const skills = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.name === "SKILL.md" && entry.isFile())) {
      const content = await fs.readFile(path.join(directory, "SKILL.md"), "utf8");
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] || "";
      const name = /^name:\s*["']?([^\r\n"']+)["']?\s*$/m.exec(frontmatter)?.[1]?.trim();
      if (name && names.has(name)) {
        const registered = registeredSkills.find((item) => (item?.name || item?.id || item) === name);
        // OpenCode 返回 location 时必须指向这份快照，避免同名全局 Skill 覆盖来源。
        const registeredPath = registered?.location;
        const expected = await fs.realpath(path.join(directory, "SKILL.md"));
        if (registeredPath && await fs.realpath(registeredPath) !== expected) {
          throw new Error(`已注册 Skill ${name} 的路径不属于当前来源快照: ${registeredPath}`);
        }
        skills.push({ name, root: directory });
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || ["node_modules", "evals"].includes(entry.name)) continue;
      await visit(path.join(directory, entry.name));
    }
  }
  await visit(root);
  skills.sort((a, b) => a.name.localeCompare(b.name));
  const duplicate = skills.find((skill, index) => skills.findIndex((item) => item.name === skill.name) !== index);
  if (duplicate) throw new Error(`来源中存在重复 Skill: ${duplicate.name}`);
  return skills;
}

async function runPython(python, args, { env, cwd, signal, timeout = 30_000 } = {}) {
  return execute(python.command, [...python.args, "-B", ...args], {
    env: { ...env, PYTHONDONTWRITEBYTECODE: "1" }, cwd, signal, timeout,
    windowsHide: true, maxBuffer: 2 * 1024 * 1024,
  });
}

export async function findSkillPython(env, signal) {
  const candidates = [
    "python3", "python3.13", "python3.12", "python3.11", "python3.10", "python",
  ].map((command) => ({ command, args: [] }));
  if (process.platform === "win32") candidates.push({ command: "py", args: ["-3"] });
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    try {
      const result = await runPython(candidate, ["-c", "import sys; assert sys.version_info >= (3, 10); print(sys.executable)"], { env, signal, timeout: 5000 });
      return { command: result.stdout.trim(), args: [] };
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  throw new Error("harmonyos-ui-multi 需要 Python >= 3.10，请安装并加入 Agent 的 PATH");
}

export async function prepareAgentSkillRuntime({ resources, registeredSkills, agent, sourceMode, signal }) {
  if (!resources?.skillsRoot || !resources?.env?.PATH) {
    throw new Error("Server 未返回 Skill 快照路径和工具环境，无法建立精确工具授权；请重启 Autorun Server");
  }
  const skills = await discoverRuntimeSkills(resources.skillsRoot, registeredSkills);
  const runtime = { skills, toolReadRoots: resources.toolReadRoots || [], env: { ...process.env, ...resources.env } };
  if (sourceMode !== "harmonyBot" || agent !== "harmonyos-multi-device") return runtime;
  const skill = skills.find((item) => item.name === ONE_MULTI_NAME);
  if (!skill) throw new Error(`${ONE_MULTI_NAME} 未在当前来源快照中注册，拒绝借用其他 Agent 的 Skill`);
  // Autorun 只依赖稳定的安装入口；其余脚本属于 Skill 内部实现，不按名称或数量耦合。
  let installer;
  try {
    installer = await regularPathInside(skill.root, path.join(skill.root, ONE_MULTI_INSTALLER));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${ONE_MULTI_NAME} 缺少安装入口: ${ONE_MULTI_INSTALLER}`);
    throw error;
  }
  if (!(await fs.stat(installer)).isFile()) throw new Error(`Skill 安装入口不是文件: ${installer}`);
  const python = await findSkillPython(runtime.env, signal);
  // 与 Agent 使用相同 PATH；先验证 CLI，避免付出模型调用成本后才降级工作流。
  const cli = await detectDevEcoCli({ env: runtime.env });
  signal?.throwIfAborted();
  const reportedCli = { ...cli, error: String(cli.error || "").slice(-2000) };
  const devecoCli = cli.installed
    ? { status: "available", command: cli.command, version: cli.version }
    : {
      status: "unavailable",
      command: cli.command,
      failureKind: cli.failureKind,
      error: reportedCli.error,
      warning: formatDevEcoCliFailure(reportedCli, resources.devecoCliRuntime),
    };
  runtime.oneMulti = {
    root: skill.root, python, devecoCli,
    ...(cli.installed ? { devecoCliVersion: cli.version } : {}),
    ...(resources.devecoCliRuntime ? { devecoCliRuntime: resources.devecoCliRuntime } : {}),
  };
  return runtime;
}

export function summarizeAgentSkillRuntime(runtime) {
  return {
    skills: runtime.skills,
    toolReadRoots: runtime.toolReadRoots,
    ...(runtime.oneMulti ? { oneMulti: runtime.oneMulti } : {}),
  };
}

// 安装器可以初始化工具数据，但不能把 .gitignore/AGENTS.md 变成业务差异。
export async function installProjectSkill({ runtime, projectDir, signal }) {
  if (!runtime.oneMulti) return null;
  const projectRoot = await fs.realpath(projectDir);
  const omRoot = path.join(projectRoot, ".onemulti");
  async function rejectLinks(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`.onemulti 不允许共享符号链接: ${path.join(directory, entry.name)}`);
      if (entry.isDirectory()) await rejectLinks(path.join(directory, entry.name));
    }
  }
  try {
    const stat = await fs.lstat(omRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(".onemulti 必须是当前工程内的独立目录");
    // 安装器会写账本并替换子目录，拒绝已有链接以防写入其他用例。
    await rejectLinks(omRoot);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const ignorePath = path.join(projectRoot, ".gitignore");
  const ignoreStat = await fs.lstat(ignorePath).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
  if (ignoreStat?.isSymbolicLink()) throw new Error("预装 Skill 时 .gitignore 不能是符号链接");
  const originalIgnore = ignoreStat ? await fs.readFile(ignorePath) : null;
  let installed;
  try {
    installed = await runPython(runtime.oneMulti.python, [path.join(runtime.oneMulti.root, ONE_MULTI_INSTALLER), projectRoot], {
      env: runtime.env, cwd: projectRoot, signal, timeout: 60_000,
    });
  } finally {
    if (originalIgnore === null) await fs.rm(ignorePath, { force: true });
    else await fs.writeFile(ignorePath, originalIgnore);
  }
  const installedStat = await fs.lstat(omRoot).catch((error) => {
    if (error.code === "ENOENT") throw new Error(`Skill 安装完成但未生成 ${omRoot}`);
    throw error;
  });
  if (installedStat.isSymbolicLink() || !installedStat.isDirectory()) throw new Error("Skill 安装结果 .onemulti 不是独立目录");
  await rejectLinks(omRoot);
  return { name: ONE_MULTI_NAME, root: omRoot, sourceRoot: runtime.oneMulti.root, output: installed.stdout };
}

export function buildAgentSandboxPolicy({ runtime, projectDir }) {
  const skillLines = runtime.skills.map((skill) => `  - ${skill.name}: ${JSON.stringify(skill.root)}`);
  const toolLines = runtime.toolReadRoots.map((root) => `  - ${JSON.stringify(root)}`);
  const devecoCliLine = runtime.oneMulti?.devecoCli?.status === "available"
    ? `- devecocli 已通过预检，版本：${runtime.oneMulti.devecoCli.version}。按 Skill 要求用于构建和运行验证。`
    : `- devecocli 当前不可用（${runtime.oneMulti?.devecoCli?.warning || "未通过预检"}）。这不是评测启动的阻断条件；继续完成 Skill 账本、静态检查、代码修改及其他可执行步骤。依赖该 CLI 的构建或运行验证必须如实标为未验证，不得伪造通过结果。`;
  return `# 工作目录与工具资源隔离要求（强制）

- 当前唯一业务工程：${JSON.stringify(projectDir)}。业务源码、任务账本、证据、报告和临时文件只能写入该工程及其子目录。
- 不得枚举、读取或尝试访问其他用例、隐藏测试、标准答案、工程外运行报告和评测数据；工具资源授权不扩大到其父目录、其他 runtime、Provider 配置或凭据。
- 业务事实以本提示词和当前工程内容为准；执行方法与平台知识可读取下列已注册 Skill 的 SKILL.md、references、domains、assets 和 scripts。Skill 自带的参考示例属于工具资料，不是其他评测用例；evals 不在授权范围。
${skillLines.join("\n") || "  - 当前来源无已注册 Skill，不得借用其他来源。"}
- 允许在当前工程 cwd 下执行上述 Skill 的安装、检查、验证和报告脚本。脚本位于工程外不构成跳过 Skill 的理由；不得改写工具源目录或把账本、缓存、证据写回共享 Skill。Python 使用 -B 避免写入工具目录的 __pycache__。
- Skill 不得因目录隔离被替换为内联模拟、手工伪造账本或省略验证。若脚本失败，应按真实错误修复调用；无法解决时明确记录未完成/未验证，不得宣称已严格执行。
- 下列目录只用于读取 SDK/API/工具资源和调用构建工具，不允许读取无关文件：
${toolLines.join("\n") || "  - 无额外工具资源目录。"}
- 允许调用 PATH 中的 Python、Node、Java、git、ohpm、hvigorw、devecocli 等已配置工具及它们的必要运行库；工具内部必要的依赖缓存不构成读取其他用例的授权。不得搜索用户主目录、扩展根目录或整个 output 来寻找工具/答案。需要额外凭据或缺失工具时报告具体依赖，不得自行遍历查找。
- 工程外设备租约工具和锁文件仅允许按下文明确路径获取/释放租约。

# Skill 调用约定（强制）

${runtime.oneMulti ? `- Autorun 已将 ${ONE_MULTI_NAME} 安装到当前工程的 .onemulti/，并已检查 Python、Skill 安装入口和 devecocli 状态；不要再次安装，不要注入 AGENTS.md 或修改 .gitignore。初始化、验证和报告仍必须由你按 Skill 完成。
${devecoCliLine}
- Python 解释器：${JSON.stringify(runtime.oneMulti.python.command)}。按照当前 Skill 文档调用实际安装到 .onemulti/scripts/ 的脚本；不要假设固定脚本清单，也不要依赖上一轮 shell 的 export 持续存在。
- 预装的 .onemulti 由 Autorun 排除出业务 Patch 和评分输入，但会随用例 ZIP 归档。` : "- 相对引用基于所属 Skill 根目录解析；优先使用已提供的本地快照，保留同来源 Skill 间的引用关系。需要新增 Skill 时不能自行突破来源白名单。"}
- 每次 shell 调用显式设置 cwd。检查真实退出码；使用管道截取输出时必须保留前序命令失败状态，不能把 tail 的成功当作脚本成功。

# 设备验证与测试阶段边界（强制）

- 可执行静态检查、依赖安装、编译验证；当业务验收或 Skill 要求目标形态运行证据时，允许并应执行必要设备验证，不能用静态推断代替运行验证。无法完成的项记录为未验证。
- 所有模拟器、hdc、HAP 安装或 UI 自动化命令都必须在同一次设备租约命令内完成，与其他 Agent 及 ohosTest 串行访问设备。
- 若启动模拟器，必须在租约命令结束前停止本次启动的同名实例，清理本次安装/测试进程。
- 不得执行正式 ohosTest；由 Autorun 在 Agent 会话结束后统一编排。Skill 自身的必要运行验证不属于正式 ohosTest。`;
}

export async function inspectSkillWorkflow({ runtime, projectDir, signal }) {
  if (!runtime.oneMulti) return undefined;
  const checks = [];
  signal?.throwIfAborted();
  const ledgerPath = path.join(projectDir, ".onemulti/decisions.json");
  try {
    const stat = await fs.stat(ledgerPath);
    if (!stat.isFile() || stat.size === 0) throw new Error("文件为空或不是普通文件");
    JSON.parse(await fs.readFile(ledgerPath, "utf8"));
    checks.push({ check: "decisions.json", status: "passed" });
  } catch (error) {
    checks.push({ check: "decisions.json", status: "missing-or-invalid", error: String(error.message).slice(-4000) });
  }
  const reportPath = path.join(projectDir, ".onemulti/adaptation-summary.html");
  const reportExists = await fs.stat(reportPath).then((stat) => stat.isFile() && stat.size > 0, () => false);
  checks.push({ check: "adaptation-summary.html", status: reportExists ? "passed" : "missing" });
  return { status: checks.every((check) => check.status === "passed") ? "validated" : "incomplete", checks };
}

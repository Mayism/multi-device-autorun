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

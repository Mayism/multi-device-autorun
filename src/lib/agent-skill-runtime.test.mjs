import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectDevEcoCli } from "./deveco-cli.mjs";
import {
  discoverRuntimeSkills, prepareAgentSkillRuntime, installProjectSkill,
  buildAgentSandboxPolicy, inspectSkillWorkflow, findSkillPython,
} from "./agent-skill-runtime.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-skill-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skillsRoot = path.join(root, "snapshot/skills");
  await fs.mkdir(skillsRoot, { recursive: true });
  return { root, skillsRoot };
}

async function addSkill(skillsRoot, name) {
  const root = path.join(skillsRoot, name);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "SKILL.md"), `---\nname: ${name}\n---\n`);
  return root;
}

test("only registered skills from this source snapshot enter the prompt", async (t) => {
  const { root, skillsRoot } = await fixture(t);
  const own = await fs.realpath(await addSkill(skillsRoot, "own"));
  await addSkill(skillsRoot, "not-registered");
  const outside = await addSkill(path.join(root, "other-agent"), "foreign");
  if (process.platform !== "win32") await fs.symlink(outside, path.join(skillsRoot, "foreign"), "dir");
  const skills = await discoverRuntimeSkills(skillsRoot, [{ name: "own" }, { name: "foreign" }]);
  assert.deepEqual(skills, [{ name: "own", root: own }]);
  const runtime = await prepareAgentSkillRuntime({
    resources: { skillsRoot, env: { PATH: process.env.PATH }, toolReadRoots: ["/sdk"] },
    registeredSkills: [{ name: "own" }], agent: "build", sourceMode: "softwareEngineering",
  });
  assert.equal(runtime.oneMulti, undefined);
  const prompt = buildAgentSandboxPolicy({ runtime, projectDir: "/case/task" });
  assert.ok(prompt.includes(own));
  assert.ok(!prompt.includes(outside));
  assert.ok(!prompt.includes("只允许访问当前工程工作目录及其子目录"));
  assert.ok(prompt.includes("不得枚举、读取或尝试访问其他用例"));
  assert.ok(prompt.includes("允许在当前工程 cwd 下执行"));
  assert.ok(prompt.includes("不能用静态推断代替运行验证"));
  assert.ok(prompt.includes("不得执行正式 ohosTest"));
  assert.equal(await installProjectSkill({ runtime, projectDir: "/does-not-exist" }), null);
  await assert.rejects(discoverRuntimeSkills(skillsRoot, [{ name: "own", location: path.join(outside, "SKILL.md") }]), /不属于当前来源快照/);
});

async function oneMultiFixture(t) {
  const state = await fixture(t);
  const skillRoot = await addSkill(state.skillsRoot, "harmonyos-ui-multi");
  const scripts = [
    "task-ledger.py", "static-check.py", "render-report.py", "check-device-types.py", "validate-state.py",
    "verification/preflight.py", "verification/evidence-session.py", "verification/prepare-device.py", "verification/run-foundation.py",
  ];
  for (const script of scripts) {
    await fs.mkdir(path.dirname(path.join(skillRoot, "scripts", script)), { recursive: true });
    await fs.writeFile(path.join(skillRoot, "scripts", script), "print('ok')\n");
  }
  await fs.writeFile(path.join(skillRoot, "scripts/install-to-project.py"), `import sys, pathlib, shutil
if '--help' in sys.argv: print('help'); sys.exit(0)
target = pathlib.Path(sys.argv[1])
dest = target / '.onemulti'
shutil.copytree(pathlib.Path(__file__).parent, dest / 'scripts', dirs_exist_ok=True)
(dest / 'scripts/install-to-project.py').unlink()
ledger = dest / 'decisions.json'
if not ledger.exists(): ledger.write_text('{}')
with (target / '.gitignore').open('a') as f: f.write('\\n/.onemulti/\\n')
print('installed')
`);
  const python = await findSkillPython(process.env);
  return { ...state, skillRoot, runtime: { skills: [{ name: "harmonyos-ui-multi", root: skillRoot }], env: process.env, toolReadRoots: [], oneMulti: { root: skillRoot, python } } };
}

test("preinstall preserves gitignore, AGENTS and existing ledger; projects do not share state", async (t) => {
  const { root, runtime } = await oneMultiFixture(t);
  for (const name of ["base", "task"]) {
    const projectDir = path.join(root, name);
    await fs.mkdir(projectDir);
    await fs.writeFile(path.join(projectDir, "AGENTS.md"), "original instructions\n");
    if (name === "base") {
      await fs.writeFile(path.join(projectDir, ".gitignore"), "build/\r\n");
      await fs.mkdir(path.join(projectDir, ".onemulti"));
      await fs.writeFile(path.join(projectDir, ".onemulti/decisions.json"), '{"task":"old"}');
    }
    const result = await installProjectSkill({ runtime, projectDir });
    assert.equal(result.root, path.join(await fs.realpath(projectDir), ".onemulti"));
    assert.equal(await fs.readFile(path.join(projectDir, "AGENTS.md"), "utf8"), "original instructions\n");
    if (name === "base") assert.equal(await fs.readFile(path.join(projectDir, ".gitignore"), "utf8"), "build/\r\n");
    else await assert.rejects(fs.access(path.join(projectDir, ".gitignore")));
  }
  assert.equal(await fs.readFile(path.join(root, "base/.onemulti/decisions.json"), "utf8"), '{"task":"old"}');
  assert.equal(await fs.readFile(path.join(root, "task/.onemulti/decisions.json"), "utf8"), "{}");
  const audit = await inspectSkillWorkflow({ runtime, projectDir: path.join(root, "task") });
  assert.equal(audit.status, "incomplete");
  assert.equal(audit.checks.at(-1).status, "missing");
});

test("failed installer restores business ignore file and does not create a session-ready result", async (t) => {
  const { root, runtime, skillRoot } = await oneMultiFixture(t);
  const projectDir = path.join(root, "base");
  await fs.mkdir(projectDir);
  await fs.writeFile(path.join(projectDir, ".gitignore"), "original\n");
  await fs.writeFile(path.join(skillRoot, "scripts/install-to-project.py"), "import sys, pathlib\np = pathlib.Path(sys.argv[1])\n(p / '.gitignore').write_text('changed')\nsys.exit(2)\n");
  await assert.rejects(installProjectSkill({ runtime, projectDir }));
  assert.equal(await fs.readFile(path.join(projectDir, ".gitignore"), "utf8"), "original\n");
});

test("workflow audit reports validator failures even when an HTML report exists", async (t) => {
  const { root, runtime, skillRoot } = await oneMultiFixture(t);
  const projectDir = path.join(root, "task");
  await fs.mkdir(projectDir);
  await installProjectSkill({ runtime, projectDir });
  await fs.writeFile(path.join(projectDir, ".onemulti/adaptation-summary.html"), "<html>report</html>");
  await fs.writeFile(path.join(skillRoot, "scripts/validate-state.py"), "import sys\nsys.stderr.write('missing evidence')\nsys.exit(2)\n");
  const audit = await inspectSkillWorkflow({ runtime, projectDir });
  assert.equal(audit.status, "incomplete");
  assert.equal(audit.checks[1].status, "failed");
  assert.match(audit.checks[1].error, /missing evidence/);
  assert.equal(audit.checks[2].status, "passed");
  await fs.writeFile(path.join(skillRoot, "scripts/validate-state.py"), "print('ok')\n");
  assert.equal((await inspectSkillWorkflow({ runtime, projectDir })).status, "validated");
});

test("preinstall rejects a linked ledger without writing into another case", { skip: process.platform === "win32" }, async (t) => {
  const { root, runtime } = await oneMultiFixture(t);
  const projectDir = path.join(root, "base");
  await fs.mkdir(path.join(projectDir, ".onemulti"), { recursive: true });
  const foreignLedger = path.join(root, "foreign.json");
  await fs.writeFile(foreignLedger, "untouched");
  await fs.symlink(foreignLedger, path.join(projectDir, ".onemulti/decisions.json"));
  await assert.rejects(installProjectSkill({ runtime, projectDir }), /符号链接/);
  assert.equal(await fs.readFile(foreignLedger, "utf8"), "untouched");
});

test("required workflow rejects missing CLI in the Agent environment before installation", async (t) => {
  const { root, skillsRoot, runtime } = await oneMultiFixture(t);
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  // Python discovery must work even though devecocli deliberately cannot resolve.
  const command = process.platform === "win32" ? "python.cmd" : "python3";
  if (process.platform === "win32") {
    // execFile cannot execute .cmd; use the real interpreter directory instead.
    runtime.env = { ...process.env, PATH: path.dirname(runtime.oneMulti.python.command) };
  } else {
    await fs.symlink(runtime.oneMulti.python.command, path.join(bin, command));
    runtime.env = { ...process.env, PATH: bin };
  }
  await assert.rejects(prepareAgentSkillRuntime({
    resources: { skillsRoot, env: runtime.env }, registeredSkills: [{ name: "harmonyos-ui-multi" }],
    agent: "harmonyos-multi-device", sourceMode: "harmonyBot",
  }), /必需的 devecocli 不可用/);
});

test("server launcher sends its actual private Skill and tool paths over IPC without credentials", { skip: process.platform === "win32" }, async (t) => {
  const { root } = await fixture(t);
  const source = path.join(root, "source");
  const bin = path.join(source, "bin", process.platform, process.arch);
  const studio = path.join(root, "studio");
  const runtime = path.join(root, "runtime");
  const npmBin = path.join(root, "npm-bin");
  await fs.mkdir(bin, { recursive: true });
  const oldNodeBin = path.join(studio, "tools", "node", "bin");
  await fs.mkdir(oldNodeBin, { recursive: true });
  await fs.mkdir(npmBin);
  await fs.writeFile(path.join(oldNodeBin, "node"), "#!/bin/sh\nexit 77\n", { mode: 0o755 });
  await fs.writeFile(path.join(npmBin, "devecocli"), "#!/usr/bin/env node\nconsole.log(process.execPath);\n", { mode: 0o755 });
  await fs.writeFile(path.join(bin, "opencode"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.writeFile(path.join(source, "opencode.json"), "{}");
  await addSkill(path.join(source, "skills"), "example");
  const launcher = fileURLToPath(new URL("../run-opencode-serve.mjs", import.meta.url));
  const messages = [];
  const child = spawn(process.execPath, [launcher, "--source", source, "--runtime-root", runtime, "--workspace", root, "--deveco-home", studio, "--isolate-config"], {
    env: { ...process.env, PATH: [npmBin, process.env.PATH].join(path.delimiter), TEST_PROVIDER_API_KEY: "not-a-real-secret" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  child.on("message", (message) => messages.push(message));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0, stderr);
  const resources = messages.find((message) => message.type === "autorun:tool-runtime")?.resources;
  assert.ok(resources.skillsRoot.startsWith(runtime + path.sep));
  assert.equal(resources.env.DEVECO_HOME, studio);
  assert.ok(resources.env.PATH.includes(path.join(studio, "tools", "hvigor", "bin")));
  assert.equal(resources.env.TEST_PROVIDER_API_KEY, undefined);
  const cli = await detectDevEcoCli({ env: { ...process.env, ...resources.env } });
  assert.equal(cli.installed, true, cli.error);
  assert.equal(cli.version, process.execPath);
  assert.equal(resources.devecoCliRuntime.nodePath, process.execPath);
  assert.ok(resources.toolReadRoots.includes(resources.devecoCliRuntime.binDir));
  const skills = await discoverRuntimeSkills(resources.skillsRoot, [{ name: "example" }]);
  assert.equal(skills.length, 1);
  assert.ok(!skills[0].root.startsWith(source + path.sep));
});

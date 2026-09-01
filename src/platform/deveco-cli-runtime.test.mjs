import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPinnedDevEcoCli } from "./deveco-cli-runtime.mjs";
import { detectDevEcoCli } from "./deveco-cli.mjs";

const execute = promisify(execFile);

test("pinned CLI bypasses old tool Node while preserving arguments, cwd, PATH and exit code", { skip: process.platform === "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autorun cli's-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installed = path.join(root, "installed");
  const old = path.join(root, "old-node");
  await fs.mkdir(installed);
  await fs.mkdir(old);
  await fs.writeFile(path.join(old, "node"), "#!/bin/sh\nexit 77\n", { mode: 0o755 });
  await fs.writeFile(path.join(installed, "devecocli"), "#!/usr/bin/env node\nconsole.log(JSON.stringify({node:process.execPath,args:process.argv.slice(2),cwd:process.cwd(),path:process.env.PATH}));process.exit(Number(process.env.TEST_EXIT_CODE || 0));\n", { mode: 0o755 });
  const pathValue = [old, installed].join(path.delimiter);
  const pinned = createPinnedDevEcoCli({ pathValue, nodePath: process.execPath, binDir: path.join(root, "cli-bin") });
  const env = { ...process.env, PATH: [pinned.binDir, pathValue].join(path.delimiter) };
  const args = ["space value", "quote's", "$(literal)"];
  const { stdout } = await execute("devecocli", args, { cwd: root, env });
  const result = JSON.parse(stdout);
  assert.equal(result.node, process.execPath);
  assert.deepEqual(result.args, args);
  assert.equal(result.cwd, await fs.realpath(root));
  assert.equal(result.path, env.PATH);
  await assert.rejects(execute("node", ["--version"], { env }), { code: 77 });
  await assert.rejects(execute("devecocli", [], { env: { ...env, TEST_EXIT_CODE: "23" } }), { code: 23 });
});

test("pinning preserves a custom shell CLI and does not invent a missing installation", { skip: process.platform === "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { pathValue: root, nodePath: process.execPath, binDir: path.join(root, "cli-bin") };
  assert.equal(createPinnedDevEcoCli(options), null);
  await fs.writeFile(path.join(root, "devecocli"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal(createPinnedDevEcoCli(options), null);
  await assert.rejects(fs.access(options.binDir));
});

function npmShim(relative) {
  return `@ECHO off\r\nSET dp0=%~dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n"%_prog%" "%dp0%\\${relative}" %*\r\n`;
}

// Windows 路径语义在任意宿主上测试；真实 cmd/PowerShell 执行由下方 Windows 测试覆盖。
function windowsFiles() {
  const files = new Map();
  const key = (file) => path.win32.normalize(file).toLowerCase();
  const read = (file) => {
    if (!files.has(key(file))) throw Object.assign(new Error(`Missing fixture: ${file}`), { code: "ENOENT" });
    return files.get(key(file));
  };
  const fileSystem = {
    accessSync(file) { read(file); },
    statSync(file) { read(file); return { isFile: () => true }; },
    realpathSync(file) { read(file); return path.win32.normalize(file); },
    readFileSync: read,
    writeFileSync(file, content) { files.set(key(file), content); },
    mkdirSync() {}, chmodSync() {},
  };
  return { fileSystem, put: fileSystem.writeFileSync, read };
}

function addWindowsPackage(fixture, directory, { local = false, legacy = false } = {}) {
  const relative = `${local ? ".." : "node_modules"}\\@deveco\\deveco-cli\\dist\\cli.js`;
  const entrypoint = path.win32.resolve(directory, relative);
  const manifest = path.win32.resolve(entrypoint, "../../package.json");
  fixture.put(entrypoint, "#!/usr/bin/env node\nconsole.log(process.execPath);\n");
  fixture.put(manifest, JSON.stringify({ name: "@deveco/deveco-cli", bin: { devecocli: "dist/cli.js" }, engines: { node: ">=22" } }));
  fixture.put(path.win32.join(directory, "devecocli.cmd"), legacy
    ? `@IF EXIST "%~dp0\\node.exe" (\r\n"%~dp0\\node.exe" "%~dp0\\${relative}" %*\r\n) ELSE (\r\nnode "%~dp0\\${relative}" %*\r\n)\r\n`
    : npmShim(relative));
  return { entrypoint, manifest };
}

test("Windows resolves global/local npm shims and pins the actual JS entrypoint", () => {
  for (const options of [{}, { local: true }, { legacy: true }]) {
    const fixture = windowsFiles();
    const directory = options.local ? "C:\\项目 空格\\node_modules\\.bin" : "C:\\Users\\test user\\AppData\\Roaming\\npm";
    const { entrypoint } = addWindowsPackage(fixture, directory, options);
    const nodePath = "C:\\Node ! 100%\\node.exe";
    const pinned = createPinnedDevEcoCli({
      pathValue: `C:\\DevEco\\tools\\node;"${directory}";C:\\Windows\\System32`,
      nodePath, binDir: "C:\\run\\cli-bin", platform: "win32", fileSystem: fixture.fileSystem,
      pathExt: ".COM;.EXE;.BAT;.CMD",
    });
    assert.equal(pinned.entrypoint, entrypoint);
    assert.equal(pinned.requiredNode, ">=22");
    assert.ok(pinned.command.endsWith("devecocli.cmd"));
    const wrapper = fixture.read(pinned.command);
    assert.ok(wrapper.includes('"C:\\Node ! 100%%\\node.exe"'));
    assert.ok(wrapper.includes(`"${entrypoint}" %*`));
    assert.match(wrapper, /setlocal DisableDelayedExpansion/);
    assert.match(wrapper, /exit \/b %errorlevel%/);
    assert.doesNotMatch(wrapper, /SET PATH|_prog|devecocli\.cmd/i);
    assert.ok(fixture.read("C:\\run\\cli-bin\\devecocli").includes(entrypoint.replace(/\\/g, "/")));
  }
});

test("Windows respects PATH/PATHEXT and does not bypass custom or broken commands", () => {
  const fixture = windowsFiles();
  addWindowsPackage(fixture, "C:\\npm");
  const options = { pathValue: "C:\\custom;C:\\npm", nodePath: "C:\\node\\node.exe", binDir: "C:\\run\\cli-bin", platform: "win32", fileSystem: fixture.fileSystem, pathExt: ".EXE;.CMD" };
  fixture.put("C:\\custom\\devecocli.exe", "native executable");
  assert.equal(createPinnedDevEcoCli(options), null);
  fixture.put("C:\\custom\\devecocli.cmd", "@echo custom wrapper\r\n");
  assert.equal(createPinnedDevEcoCli({ ...options, pathExt: ".CMD;.EXE" }), null);
  fixture.put("C:\\custom\\devecocli.cmd", npmShim("node_modules\\@deveco\\deveco-cli\\missing.js"));
  assert.throws(() => createPinnedDevEcoCli({ ...options, pathExt: ".CMD;.EXE" }), /无法解析 PATH 中的 devecocli 入口/);
  assert.equal(createPinnedDevEcoCli({ ...options, pathValue: "C:\\empty" }), null);
});

test("Windows verifies the package bin before replacing a shim", () => {
  const fixture = windowsFiles();
  const { manifest } = addWindowsPackage(fixture, "C:\\npm");
  fixture.put(manifest, JSON.stringify({ name: "unrelated-package", bin: { devecocli: "dist/cli.js" } }));
  assert.equal(createPinnedDevEcoCli({ pathValue: "C:\\npm", nodePath: "C:\\node\\node.exe", binDir: "C:\\run\\cli-bin", platform: "win32", fileSystem: fixture.fileSystem }), null);
});

test("Windows cmd and PowerShell execute pinned CLI with arguments and original tool PATH", { skip: process.platform !== "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autorun CLI ! 100% 中文's-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const npmBin = path.join(root, "npm");
  const packageRoot = path.join(npmBin, "node_modules/@deveco/deveco-cli");
  const oldBin = path.join(root, "old-node");
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await fs.mkdir(oldBin);
  await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@deveco/deveco-cli", bin: { devecocli: "dist/cli.js" } }));
  await fs.writeFile(path.join(packageRoot, "dist/cli.js"), "console.log(JSON.stringify({node:process.execPath,args:process.argv.slice(2),cwd:process.cwd(),path:process.env.PATH}));process.exit(Number(process.env.TEST_EXIT_CODE || 0));\n");
  await fs.writeFile(path.join(npmBin, "devecocli.cmd"), npmShim("node_modules\\@deveco\\deveco-cli\\dist\\cli.js"));
  await fs.writeFile(path.join(oldBin, "node.cmd"), "@echo v18.20.1\r\n@exit /b 0\r\n");
  const toolPath = [oldBin, npmBin, process.env.PATH].join(path.delimiter);
  const pinned = createPinnedDevEcoCli({ pathValue: toolPath, nodePath: process.execPath, binDir: path.join(root, "cli-bin") });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.PATH = [pinned.binDir, toolPath].join(path.delimiter);
  const cli = await detectDevEcoCli({ env });
  assert.equal(cli.installed, true, cli.error);
  assert.equal(JSON.parse(cli.version).node, process.execPath);
  for (const shell of ["cmd", "powershell"]) {
    const invoke = (extraEnv = {}) => shell === "cmd"
      ? execute('devecocli "space value" 中文', [], { shell: process.env.ComSpec || "cmd.exe", cwd: root, env: { ...env, ...extraEnv } })
      : execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); devecocli 'space value' 中文; exit $LASTEXITCODE"], { cwd: root, env: { ...env, ...extraEnv } });
    const result = JSON.parse((await invoke()).stdout);
    assert.equal(result.node, process.execPath);
    assert.deepEqual(result.args, ["space value", "中文"]);
    assert.equal(result.cwd.toLowerCase(), (await fs.realpath(root)).toLowerCase());
    assert.equal(result.path, env.PATH);
    await assert.rejects(invoke({ TEST_EXIT_CODE: "23" }), { code: 23 });
  }
  assert.equal((await execute("node --version", [], { env, shell: process.env.ComSpec || "cmd.exe" })).stdout.trim(), "v18.20.1");
});

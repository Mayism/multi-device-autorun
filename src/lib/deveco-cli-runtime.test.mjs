import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPinnedDevEcoCli } from "./deveco-cli-runtime.mjs";

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

test("Windows npm shims are not treated as JavaScript entrypoints", () => {
  assert.equal(createPinnedDevEcoCli({ pathValue: "C:\\node", nodePath: "C:\\node\\node.exe", binDir: "C:\\runtime\\cli-bin", platform: "win32" }), null);
});

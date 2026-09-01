import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEVECO_CLI_INSTALL_COMMAND,
  createDevEcoCliVersionInvocation,
  decodeDevEcoCliOutput,
  detectDevEcoCli,
  formatDevEcoCliFailure,
} from "./deveco-cli.mjs";

test("reports the install command when devecocli is absent", async () => {
  const result = await detectDevEcoCli({ env: { PATH: "" }, platform: "darwin" });
  assert.equal(result.installed, false);
  assert.equal(result.command, "devecocli");
  assert.equal(result.installCommand, DEVECO_CLI_INSTALL_COMMAND);
  assert.equal(result.failureKind, "not-found");
  assert.ok(formatDevEcoCliFailure(result).includes(DEVECO_CLI_INSTALL_COMMAND));
});

test("macOS executes devecocli from PATH and reports its version", { skip: process.platform === "win32" }, async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-deveco-cli-"));
  const executable = path.join(tempDir, "devecocli");
  await fs.writeFile(executable, "#!/bin/sh\nprintf '1.3.0\\n'\n", { mode: 0o755 });
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  const result = await detectDevEcoCli({
    env: { PATH: tempDir },
    platform: "darwin",
  });

  assert.equal(result.installed, true);
  assert.equal(result.version, "1.3.0");
  assert.equal(result.error, "");
});

test("Windows delegates command-name resolution to cmd.exe without quoting a shim path", () => {
  assert.deepEqual(createDevEcoCliVersionInvocation({
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    platform: "win32",
  }), {
    command: "devecocli --version",
    args: [],
    shell: "C:\\Windows\\System32\\cmd.exe",
  });
});

test("a command failure is reported as unavailable instead of installed", async () => {
  const result = await detectDevEcoCli({
    versionReader: async () => ({ ok: false, version: "", error: "退出码 1" }),
  });
  assert.equal(result.installed, false);
  assert.equal(result.error, "退出码 1");
  assert.equal(result.failureKind, "command-failed");
  assert.doesNotMatch(formatDevEcoCliFailure(result), /npm install/);
});

test("Node incompatibility includes the pinned runtime and does not suggest reinstalling", async () => {
  const result = await detectDevEcoCli({ versionReader: async () => ({ ok: false, error: "SyntaxError: Invalid regular expression flags\nNode.js v18.20.1" }) });
  assert.equal(result.failureKind, "runtime-incompatible");
  const message = formatDevEcoCliFailure(result, { nodePath: "C:\\Node18\\node.exe", requiredNode: ">=22" });
  assert.match(message, /Node 运行时不兼容/);
  assert.ok(message.includes("C:\\Node18\\node.exe"));
  assert.ok(message.includes(">=22"));
  assert.doesNotMatch(message, /npm install/);
});

test("Windows missing-command diagnostics distinguish CLI absence from internal failures", async () => {
  for (const error of ["'devecocli' is not recognized as an internal or external command", "'devecocli' 不是内部或外部命令，也不是可运行的程序"]) {
    const result = await detectDevEcoCli({ versionReader: async () => ({ ok: false, error }) });
    assert.equal(result.failureKind, "not-found");
  }
  const nested = await detectDevEcoCli({ versionReader: async () => ({ ok: false, error: "devecocli failed: 'hdc' is not recognized as an internal or external command" }) });
  assert.equal(nested.failureKind, "command-failed");
  const timeout = await detectDevEcoCli({ versionReader: async () => ({ ok: false, error: "timeout", failureKind: "timeout" }) });
  assert.equal(timeout.failureKind, "timeout");
  assert.doesNotMatch(formatDevEcoCliFailure(timeout), /npm install/);
});

test("Windows command errors fall back from UTF-8 to GB18030", () => {
  const encoded = Buffer.from("b2bbcac7c4dab2bfbbf2cde2b2bfc3fcc1ee", "hex");
  assert.equal(decodeDevEcoCliOutput([encoded], "win32"), "不是内部或外部命令");
});

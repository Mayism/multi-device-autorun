import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEVECO_CLI_INSTALL_COMMAND,
  decodeDevEcoCliOutput,
  detectDevEcoCli,
} from "./deveco-cli.mjs";

test("reports the install command when devecocli is absent", async () => {
  const result = await detectDevEcoCli({ env: { PATH: "" }, platform: "darwin" });
  assert.equal(result.installed, false);
  assert.equal(result.command, "devecocli");
  assert.equal(result.installCommand, DEVECO_CLI_INSTALL_COMMAND);
});

test("reports the executable path and version when devecocli is installed", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-deveco-cli-"));
  const executable = path.join(tempDir, "devecocli");
  await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  const result = await detectDevEcoCli({
    env: { PATH: tempDir },
    platform: "darwin",
    versionReader: async () => ({ version: "1.3.0", error: "" }),
  });

  assert.equal(result.installed, true);
  assert.equal(result.executable, executable);
  assert.equal(result.version, "1.3.0");
  assert.equal(result.versionError, "");
});

test("Windows ignores the extensionless npm shim and selects devecocli.cmd", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-deveco-cli-win-"));
  const extensionlessShim = path.join(tempDir, "devecocli");
  const commandShim = path.join(tempDir, "devecocli.cmd");
  await fs.writeFile(extensionlessShim, "#!/bin/sh\n");
  await fs.writeFile(commandShim, "@echo 1.3.0\r\n");
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  const result = await detectDevEcoCli({
    env: { Path: tempDir, PATHEXT: ".EXE;.CMD" },
    platform: "win32",
    versionReader: async (executable) => ({
      version: path.basename(executable).toLowerCase() === "devecocli.cmd" ? "1.3.0" : "",
      error: "",
    }),
  });

  assert.equal(result.installed, true);
  assert.equal(result.executable, commandShim);
  assert.equal(result.version, "1.3.0");
});

test("Windows command errors fall back from UTF-8 to GB18030", () => {
  const encoded = Buffer.from("b2bbcac7c4dab2bfbbf2cde2b2bfc3fcc1ee", "hex");
  assert.equal(decodeDevEcoCliOutput([encoded], "win32"), "不是内部或外部命令");
});

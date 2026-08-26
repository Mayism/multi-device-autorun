import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEVECO_CLI_INSTALL_COMMAND,
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

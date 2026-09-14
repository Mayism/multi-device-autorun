import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HARMONY_VSCODE_EXTENSION_PREFIX,
  findHarmonyDevAssistantExtension,
  resolveOpenCodeSource,
} from "./opencode-installation.mjs";

async function createExtensionFixture(root, {
  version = "1.2.3",
  includeLauncher = true,
  includeBundleHash = true,
} = {}) {
  const extensionDir = path.join(root, `${HARMONY_VSCODE_EXTENSION_PREFIX}-${version}-${process.platform}-${process.arch}`);
  const resourcesDir = path.join(extensionDir, "resources", "opencode");
  const executableName = process.platform === "win32" ? "opencode.exe" : "opencode";
  const executableRelativePath = path.join("bin", process.platform, process.arch, executableName);
  const opencodeBinPath = path.join(resourcesDir, executableRelativePath);
  const serverLauncherPath = path.join(extensionDir, "tools", "plugin-cli", "run-opencode-serve.mjs");
  await fs.mkdir(path.dirname(opencodeBinPath), { recursive: true });
  await fs.writeFile(path.join(extensionDir, "package.json"), JSON.stringify({
    publisher: "huaweideveloperserviceplatform",
    name: "harmonyosdevassistantforvscode",
    version,
  }));
  await fs.writeFile(path.join(resourcesDir, "opencode.json"), "{}\n");
  await fs.writeFile(opencodeBinPath, "fixture\n");
  await fs.writeFile(path.join(resourcesDir, "bundled-opencode.json"), JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    exeRelativePath: executableRelativePath.split(path.sep).join("/"),
  }));
  if (includeLauncher) {
    await fs.mkdir(path.dirname(serverLauncherPath), { recursive: true });
    await fs.writeFile(serverLauncherPath, "// fixture\n");
  }
  if (includeBundleHash) {
    await fs.writeFile(path.join(resourcesDir, ".bundle-hash"), "0123456789abcdef\n");
  }
  return { extensionDir, resourcesDir, opencodeBinPath, serverLauncherPath };
}

test("HarmonyBot resolution delegates Bundle selection to the plugin launcher", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-extension-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const extensionsRoot = path.join(root, "extensions");
  const fixture = await createExtensionFixture(extensionsRoot);

  const resolved = await findHarmonyDevAssistantExtension(extensionsRoot);
  assert.equal(resolved.resourcesDir, fixture.resourcesDir);
  assert.equal(resolved.opencodeBinPath, fixture.opencodeBinPath);
  assert.equal(resolved.serverLauncherPath, fixture.serverLauncherPath);
  assert.equal(Object.hasOwn(resolved, "bundleHash"), false);
  assert.equal(Object.hasOwn(resolved, "bundleStatus"), false);
  assert.equal(Object.hasOwn(resolved, "assetsDir"), false);
  if (process.platform !== "win32") {
    assert.notEqual((await fs.stat(fixture.opencodeBinPath)).mode & 0o100, 0);
  }
});

test("HarmonyBot source accepts the exact installed extension directory", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-extension-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = await createExtensionFixture(path.join(root, "extensions"));

  const resolved = await resolveOpenCodeSource({ mode: "harmonyBot", root: fixture.extensionDir });
  assert.equal(resolved.installation.extensionDir, fixture.extensionDir);
  assert.equal(resolved.serverLauncherPath, fixture.serverLauncherPath);
  assert.equal(resolved.assetsDir, "");
});

test("HarmonyBot source does not inspect or require a Bundle hash", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-extension-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = await createExtensionFixture(path.join(root, "extensions"), { includeBundleHash: false });

  const resolved = await findHarmonyDevAssistantExtension(path.dirname(fixture.extensionDir));
  assert.equal(resolved.extensionDir, fixture.extensionDir);
  assert.equal(resolved.serverLauncherPath, fixture.serverLauncherPath);
});

test("highest usable HarmonyBot version is selected", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-extension-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const extensionsRoot = path.join(root, "extensions");
  await createExtensionFixture(extensionsRoot, { version: "1.2.3" });
  const newest = await createExtensionFixture(extensionsRoot, { version: "1.3.0" });

  const resolved = await findHarmonyDevAssistantExtension(extensionsRoot);
  assert.equal(resolved.extensionDir, newest.extensionDir);
  assert.equal(resolved.version, "1.3.0");
});

test("extension without the official server launcher reports the actual reason", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-extension-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const extensionsRoot = path.join(root, "extensions");
  await createExtensionFixture(extensionsRoot, { includeLauncher: false });

  await assert.rejects(
    findHarmonyDevAssistantExtension(extensionsRoot),
    /已找到 HarmonyOS Dev Assistant 扩展.*未提供 OpenCode 启动器/,
  );
});

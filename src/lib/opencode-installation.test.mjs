import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createZip } from "./zip.mjs";
import {
  HARMONY_VSCODE_EXTENSION_PREFIX,
  findHarmonyDevAssistantExtension,
} from "./opencode-installation.mjs";

async function createExtensionFixture(root, {
  version = "1.2.3",
  bundleHash = "0123456789abcdef",
  legacy = false,
  includeSkillsZip = true,
} = {}) {
  const extensionDir = path.join(root, `${HARMONY_VSCODE_EXTENSION_PREFIX}-${version}-${process.platform}-${process.arch}`);
  const resourcesDir = path.join(extensionDir, "resources", "opencode");
  const executableName = process.platform === "win32" ? "opencode.exe" : "opencode";
  const executableRelativePath = path.join("bin", process.platform, process.arch, executableName);
  const opencodeBinPath = path.join(resourcesDir, executableRelativePath);
  await fs.mkdir(path.dirname(opencodeBinPath), { recursive: true });
  await fs.mkdir(path.join(resourcesDir, "plugin"), { recursive: true });
  await fs.writeFile(path.join(extensionDir, "package.json"), JSON.stringify({
    publisher: "huaweideveloperserviceplatform",
    name: "harmonyosdevassistantforvscode",
    version,
  }));
  await fs.writeFile(path.join(resourcesDir, "opencode.json"), "{}\n");
  await fs.writeFile(path.join(resourcesDir, "plugin", "plugin.js"), "export {};\n");
  await fs.writeFile(opencodeBinPath, "fixture\n");
  await fs.writeFile(path.join(resourcesDir, "bundled-opencode.json"), JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    exeRelativePath: executableRelativePath.split(path.sep).join("/"),
  }));

  if (legacy) {
    await fs.mkdir(path.join(resourcesDir, "skills", "fixture-skill"), { recursive: true });
    await fs.writeFile(path.join(resourcesDir, "skills", "fixture-skill", "SKILL.md"), "# fixture\n");
  } else {
    await fs.writeFile(path.join(resourcesDir, ".bundle-hash"), `${bundleHash}\n`);
    if (includeSkillsZip) {
      const skillFile = path.join(root, "fixture-skill.md");
      await fs.writeFile(skillFile, "# fixture\n");
      const archive = await createZip([{ absPath: skillFile, zipPath: "fixture-skill/SKILL.md" }]);
      await fs.writeFile(path.join(resourcesDir, "skills.zip"), archive);
    }
  }
  return { extensionDir, resourcesDir, opencodeBinPath, bundleHash };
}

test("hashed HarmonyBot extension materializes and reuses its content-addressed Bundle", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-extension-"));
  const extensionsRoot = path.join(root, "extensions");
  const homeDir = path.join(root, "home");
  try {
    const fixture = await createExtensionFixture(extensionsRoot);
    const first = await findHarmonyDevAssistantExtension(extensionsRoot, { homeDir });
    const expectedBundleDir = path.join(
      homeDir,
      ".harmonybot",
      "opencode-bundle",
      "vscode",
      fixture.bundleHash,
    );
    assert.equal(first.resourcesDir, fixture.resourcesDir);
    assert.equal(first.assetsDir, expectedBundleDir);
    assert.equal(first.opencodeBinPath, fixture.opencodeBinPath);
    assert.equal(first.bundleStatus, "prepared");
    assert.equal(await fs.readFile(path.join(expectedBundleDir, ".bundle-complete"), "utf8"), "ok\n");
    assert.equal(await fs.readFile(path.join(expectedBundleDir, "skills", "fixture-skill", "SKILL.md"), "utf8"), "# fixture\n");
    assert.equal(await fs.stat(path.join(expectedBundleDir, "bin")).then(() => true, () => false), false);

    await fs.rm(path.join(fixture.resourcesDir, "skills.zip"));
    const second = await findHarmonyDevAssistantExtension(extensionsRoot, { homeDir });
    assert.equal(second.resourcesDir, fixture.resourcesDir);
    assert.equal(second.assetsDir, expectedBundleDir);
    assert.equal(second.bundleStatus, "cached");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("legacy HarmonyBot extension continues to use resources/opencode directly", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-extension-"));
  const extensionsRoot = path.join(root, "extensions");
  try {
    const fixture = await createExtensionFixture(extensionsRoot, { legacy: true });
    const resolved = await findHarmonyDevAssistantExtension(extensionsRoot, { homeDir: path.join(root, "home") });
    assert.equal(resolved.resourcesDir, fixture.resourcesDir);
    assert.equal(resolved.assetsDir, fixture.resourcesDir);
    assert.equal(resolved.opencodeBinPath, fixture.opencodeBinPath);
    assert.equal(resolved.bundleStatus, "legacy");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("installed extension with an incomplete Bundle reports the actual reason", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-extension-"));
  const extensionsRoot = path.join(root, "extensions");
  try {
    await createExtensionFixture(extensionsRoot, { includeSkillsZip: false });
    await assert.rejects(
      findHarmonyDevAssistantExtension(extensionsRoot, { homeDir: path.join(root, "home") }),
      /已找到 HarmonyOS Dev Assistant 扩展.*解压后的 Bundle 不完整.*skills\//,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

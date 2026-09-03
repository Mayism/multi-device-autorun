import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ensureHarmonyBotBundle } from "./opencode-bundle-cache.mjs";

export const HARMONY_VSCODE_EXTENSION_PREFIX = "huaweideveloperserviceplatform.harmonyosdevassistantforvscode";
export const OPENCODE_SOURCE_MODES = Object.freeze({
  HARMONY_BOT: "harmonyBot",
  SOFTWARE_ENGINEERING: "softwareEngineering",
});

function compareVersions(left, right) {
  const parse = (value) => {
    const [core, prerelease = ""] = String(value || "0.0.0").split("-", 2);
    return { numbers: core.split(".").map((part) => Number(part) || 0), prerelease };
  };
  const a = parse(left);
  const b = parse(right);
  const size = Math.max(a.numbers.length, b.numbers.length);
  for (let index = 0; index < size; index += 1) {
    const difference = (a.numbers[index] || 0) - (b.numbers[index] || 0);
    if (difference) return difference;
  }
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
}
async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function opencodeExecutableName() {
  return process.platform === "win32" ? "opencode.exe" : "opencode";
}

function safeRelativePath(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (!normalized || path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || parts.includes("..")) {
    return null;
  }
  return parts;
}

async function resolveBundledOpenCode(resourcesDir) {
  const metadataPath = path.join(resourcesDir, "bundled-opencode.json");
  if (await exists(metadataPath)) {
    let metadata;
    try {
      metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    } catch (error) {
      throw new Error(`bundled-opencode.json 无法解析: ${error.message}`);
    }
    if (metadata.platform !== process.platform || metadata.arch !== process.arch) {
      throw new Error(
        `OpenCode 二进制平台不匹配: Bundle=${metadata.platform}/${metadata.arch}，当前=${process.platform}/${process.arch}`,
      );
    }
    const segments = safeRelativePath(metadata.exeRelativePath);
    if (!segments) throw new Error("bundled-opencode.json 的 exeRelativePath 无效");
    const executable = path.join(resourcesDir, ...segments);
    if (!await exists(executable)) throw new Error(`OpenCode 二进制不存在: ${executable}`);
    return executable;
  }

  const executable = path.join(
    resourcesDir,
    "bin",
    process.platform,
    process.arch,
    opencodeExecutableName(),
  );
  if (!await exists(executable)) throw new Error(`OpenCode 二进制不存在: ${executable}`);
  return executable;
}

async function validateLegacyResources(resourcesDir) {
  const missing = [];
  for (const required of ["opencode.json", "plugin", "skills"]) {
    if (!await exists(path.join(resourcesDir, required))) missing.push(required);
  }
  if (missing.length) throw new Error(`resources/opencode 缺少 ${missing.join("、")}`);
}

async function resolveBundleHash(resourcesDir) {
  const hashPath = path.join(resourcesDir, ".bundle-hash");
  if (await exists(hashPath)) return (await fs.readFile(hashPath, "utf8")).trim();

  const archives = [
    path.join(resourcesDir, "skills.zip"),
    path.join(resourcesDir, "plugin", "hmos-library-adapter-fast.zip"),
  ];
  const available = [];
  for (const archive of archives) {
    if (await exists(archive)) available.push(archive);
  }
  if (!available.length) return "";
  const hash = createHash("sha256");
  for (const archive of available) hash.update(await fs.readFile(archive));
  return hash.digest("hex").slice(0, 16);
}

async function resolveHarmonyBotResources(extensionDir, { homeDir = os.homedir(), cacheRoot } = {}) {
  const bundledResourcesDir = path.join(extensionDir, "resources", "opencode");
  const opencodeBinPath = await resolveBundledOpenCode(bundledResourcesDir);
  const bundleHash = await resolveBundleHash(bundledResourcesDir);
  if (!bundleHash) {
    await validateLegacyResources(bundledResourcesDir);
    return {
      resourcesDir: bundledResourcesDir,
      assetsDir: bundledResourcesDir,
      bundledResourcesDir,
      opencodeBinPath,
      bundleHash: "",
      bundleStatus: "legacy",
    };
  }

  const prepared = await ensureHarmonyBotBundle({
    sourceDir: bundledResourcesDir,
    bundleHash,
    cacheRoot: cacheRoot || path.join(homeDir, ".harmonybot", "opencode-bundle", "vscode"),
  });
  return {
    resourcesDir: bundledResourcesDir,
    assetsDir: prepared.bundleDir,
    bundledResourcesDir,
    opencodeBinPath,
    bundleHash,
    bundleStatus: prepared.status,
  };
}

export async function findHarmonyDevAssistantExtension(extensionsRoot, options = {}) {
  const absoluteRoot = path.resolve(String(extensionsRoot || ""));
  if (!extensionsRoot || !await exists(absoluteRoot)) {
    throw new Error(`VS Code 扩展目录不存在: ${absoluteRoot}`);
  }

  const entries = await fs.readdir(absoluteRoot, { withFileTypes: true });
  const prefix = HARMONY_VSCODE_EXTENSION_PREFIX.toLowerCase();
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.toLowerCase().startsWith(prefix)) continue;
    const extensionDir = path.join(absoluteRoot, entry.name);
    const packagePath = path.join(extensionDir, "package.json");
    try {
      const manifest = JSON.parse(await fs.readFile(packagePath, "utf8"));
      if (String(manifest.publisher || "").toLowerCase() !== "huaweideveloperserviceplatform") continue;
      if (String(manifest.name || "").toLowerCase() !== "harmonyosdevassistantforvscode") continue;
      candidates.push({ extensionDir, version: String(manifest.version || "0.0.0") });
    } catch {
      // 忽略名称匹配但清单无效的目录。
    }
  }

  if (!candidates.length) {
    throw new Error(`未在 ${absoluteRoot} 找到已安装扩展: ${HARMONY_VSCODE_EXTENSION_PREFIX}-*`);
  }
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  const failures = [];
  for (const candidate of candidates) {
    try {
      const resolved = await resolveHarmonyBotResources(candidate.extensionDir, options);
      return { ...candidate, ...resolved };
    } catch (error) {
      failures.push(`${path.basename(candidate.extensionDir)}: ${error.message}`);
    }
  }
  throw new Error(
    `已找到 HarmonyOS Dev Assistant 扩展，但 OpenCode Bundle 不可用：${failures.join("；")}`,
  );
}

export async function resolveOpenCodeSource(source, options = {}) {
  const mode = String(source?.mode || "").trim();
  const configuredRoot = String(source?.root || "").trim();
  if (!Object.values(OPENCODE_SOURCE_MODES).includes(mode)) {
    throw new Error(
      `server.opencodeSource.mode 仅支持 ${Object.values(OPENCODE_SOURCE_MODES).join(" 或 ")}: ${mode || "<empty>"}`,
    );
  }
  if (!configuredRoot) {
    throw new Error(`server.opencodeSource.root 不能为空（当前模式: ${mode}）`);
  }

  if (mode === OPENCODE_SOURCE_MODES.HARMONY_BOT) {
    const installation = await findHarmonyDevAssistantExtension(configuredRoot, options);
    return {
      mode,
      root: path.resolve(configuredRoot),
      resourcesDir: installation.resourcesDir,
      assetsDir: installation.assetsDir,
      opencodeBinPath: installation.opencodeBinPath,
      installation,
    };
  }

  const root = path.resolve(configuredRoot);
  if (!await exists(root)) {
    throw new Error(`softwareEngineering 资源根目录不存在: ${root}`);
  }
  const resourcesDir = path.join(root, "resources", "opencode");
  const missing = [];
  for (const required of ["opencode.json", "skills"]) {
    if (!await exists(path.join(resourcesDir, required))) missing.push(required);
  }
  if (missing.length) {
    throw new Error(
      `softwareEngineering 资源不完整: ${resourcesDir}（缺少 ${missing.join("、")}）`,
    );
  }
  const opencodeBinPath = await resolveBundledOpenCode(resourcesDir);
  return { mode, root, resourcesDir, assetsDir: resourcesDir, opencodeBinPath, installation: null };
}

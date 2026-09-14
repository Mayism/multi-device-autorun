import fs from "node:fs/promises";
import path from "node:path";

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
    await ensureExecutable(executable);
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
  await ensureExecutable(executable);
  return executable;
}

async function ensureExecutable(executable) {
  if (process.platform === "win32") return;
  const stat = await fs.stat(executable);
  if ((stat.mode & 0o111) === 0) await fs.chmod(executable, stat.mode | 0o100);
}

async function resolveHarmonyBotResources(extensionDir) {
  const bundledResourcesDir = path.join(extensionDir, "resources", "opencode");
  const opencodeBinPath = await resolveBundledOpenCode(bundledResourcesDir);
  const serverLauncherPath = path.join(extensionDir, "tools", "plugin-cli", "run-opencode-serve.mjs");
  if (!await exists(serverLauncherPath)) {
    throw new Error(`HarmonyBot 插件未提供 OpenCode 启动器: ${serverLauncherPath}`);
  }
  return {
    resourcesDir: bundledResourcesDir,
    bundledResourcesDir,
    opencodeBinPath,
    serverLauncherPath,
  };
}

async function readHarmonyBotCandidate(extensionDir) {
  const packagePath = path.join(extensionDir, "package.json");
  try {
    const manifest = JSON.parse(await fs.readFile(packagePath, "utf8"));
    if (String(manifest.publisher || "").toLowerCase() !== "huaweideveloperserviceplatform") return null;
    if (String(manifest.name || "").toLowerCase() !== "harmonyosdevassistantforvscode") return null;
    return { extensionDir, version: String(manifest.version || "0.0.0") };
  } catch {
    return null;
  }
}

export async function findHarmonyDevAssistantExtension(extensionsRoot) {
  const absoluteRoot = path.resolve(String(extensionsRoot || ""));
  if (!extensionsRoot || !await exists(absoluteRoot)) {
    throw new Error(`VS Code 扩展目录不存在: ${absoluteRoot}`);
  }

  const candidates = [];
  const exact = await readHarmonyBotCandidate(absoluteRoot);
  if (exact) {
    candidates.push(exact);
  } else {
    const entries = await fs.readdir(absoluteRoot, { withFileTypes: true });
    const prefix = HARMONY_VSCODE_EXTENSION_PREFIX.toLowerCase();
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.toLowerCase().startsWith(prefix)) continue;
      const candidate = await readHarmonyBotCandidate(path.join(absoluteRoot, entry.name));
      if (candidate) candidates.push(candidate);
    }
  }

  if (!candidates.length) {
    throw new Error(`未在 ${absoluteRoot} 找到已安装扩展: ${HARMONY_VSCODE_EXTENSION_PREFIX}-*`);
  }
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  const failures = [];
  for (const candidate of candidates) {
    try {
      const resolved = await resolveHarmonyBotResources(candidate.extensionDir);
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
    const installation = await findHarmonyDevAssistantExtension(configuredRoot);
    return {
      mode,
      root: path.resolve(configuredRoot),
      resourcesDir: installation.resourcesDir,
      assetsDir: "",
      opencodeBinPath: installation.opencodeBinPath,
      serverLauncherPath: installation.serverLauncherPath,
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

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

export async function findHarmonyDevAssistantExtension(extensionsRoot) {
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
      const resourcesDir = path.join(extensionDir, "resources", "opencode");
      for (const required of ["opencode.json", "bin", "plugin", "skills"]) {
        if (!await exists(path.join(resourcesDir, required))) throw new Error(`缺少 ${required}`);
      }
      candidates.push({ extensionDir, resourcesDir, version: String(manifest.version || "0.0.0") });
    } catch {
      // 忽略名称匹配但尚未安装完整或清单无效的目录。
    }
  }

  if (!candidates.length) {
    throw new Error(`未在 ${absoluteRoot} 找到有效扩展: ${HARMONY_VSCODE_EXTENSION_PREFIX}-*`);
  }
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  return candidates[0];
}

export async function resolveOpenCodeSource(source) {
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
      installation,
    };
  }

  const root = path.resolve(configuredRoot);
  if (!await exists(root)) {
    throw new Error(`softwareEngineering 资源根目录不存在: ${root}`);
  }
  const resourcesDir = path.join(root, "resources", "opencode");
  const missing = [];
  for (const required of ["opencode.json", "bin", "skills"]) {
    if (!await exists(path.join(resourcesDir, required))) missing.push(required);
  }
  if (missing.length) {
    throw new Error(
      `softwareEngineering 资源不完整: ${resourcesDir}（缺少 ${missing.join("、")}）`,
    );
  }
  return { mode, root, resourcesDir, installation: null };
}

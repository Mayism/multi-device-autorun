import fs from "node:fs/promises";
import path from "node:path";

export const GENERATED_ARTIFACT_GIT_EXCLUDES = [
  ".onemulti/",
  ".hvigor/",
  "oh_modules/",
  "build/",
  "node_modules/",
  "local.properties",
  "/layout_[0-9]*.json",
  "/screenshots/",
  "__pycache__/",
  "*.pyc",
  "**/evidence/tmp/",
];

function normalizeRelativePath(relativePath) {
  return String(relativePath || "")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

export function isGeneratedArtifactExcluded(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const parts = normalized.split("/").filter(Boolean);
  if ([".onemulti", ".hvigor", "oh_modules", "build", "node_modules", "__pycache__"].some((part) => parts.includes(part))) return true;
  if (parts.at(-1) === "local.properties") return true;
  if (parts.length === 1 && /^layout_\d+\.json$/.test(parts[0])) return true;
  if (parts[0] === "screenshots") return true;
  if (parts.at(-1)?.toLowerCase().endsWith(".pyc")) return true;
  return parts.some((part, index) => part === "evidence" && parts[index + 1] === "tmp");
}

// DevEco 的编译会覆盖已跟踪的 BuildProfile.ets。只还原这一项已知的构建模式改写，
// 同一文件中的其他 Agent 修改仍保留在 patch 中。
export function restoreGeneratedBuildMode(baselineContent, currentContent, relativePath) {
  if (path.posix.basename(normalizeRelativePath(relativePath)) !== "BuildProfile.ets") return currentContent;
  const buildModeLine = /^export const BUILD_MODE_NAME = '([^']+)';$/m;
  const baselineMode = buildModeLine.exec(baselineContent)?.[1];
  const currentMode = buildModeLine.exec(currentContent)?.[1];
  if (baselineMode !== "test" || currentMode !== "debug") return currentContent;
  return currentContent.replace(buildModeLine, "export const BUILD_MODE_NAME = 'test';");
}

// 临时缓存可以清理，也不应进入归档；.onemulti 的正式产物需保留并打包。
export function isGeneratedArtifactPrunable(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.includes("__pycache__")) return true;
  if (parts.at(-1)?.toLowerCase().endsWith(".pyc")) return true;
  return parts.some((part, index) => part === "evidence" && parts[index + 1] === "tmp");
}

function lineReferencesExcludedFile(line) {
  const diffMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  if (diffMatch) {
    return [diffMatch[1], diffMatch[2]].some(isGeneratedArtifactExcluded);
  }
  const markerMatch = /^(?:---|\+\+\+) (?:a|b)\/(.+)$/.exec(line);
  return Boolean(markerMatch?.[1] && isGeneratedArtifactExcluded(markerMatch[1]));
}

export function filterGeneratedArtifactPatch(patchText) {
  if (!patchText.includes("diff --git")) return patchText;
  const hasTrailingNewline = patchText.endsWith("\n");
  const lines = (hasTrailingNewline ? patchText.slice(0, -1) : patchText).split("\n");
  const kept = [];
  let section = [];
  let excluded = false;

  const flush = () => {
    // UI 工具会在工程根目录留下空的 layout.json；有内容的同名文件仍属于工程修改。
    const emptyRootLayout = section[0] === "diff --git a/layout.json b/layout.json"
      && section.includes("new file mode 100644")
      && section.includes("index 0000000..e69de29");
    if (section.length && !excluded && !emptyRootLayout) kept.push(...section);
    section = [];
    excluded = false;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) flush();
    section.push(line);
    if (lineReferencesExcludedFile(line)) excluded = true;
  }
  flush();
  if (!kept.length) return "";
  return `${kept.join("\n")}${hasTrailingNewline ? "\n" : ""}`;
}

function resolveInside(rootDir, relativePath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`拒绝清理工程目录外路径: ${target}`);
  }
  return target;
}

export async function pruneGeneratedArtifacts(rootDir) {
  const root = path.resolve(rootDir);
  const removed = [];

  async function visit(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(currentDir, entry.name);
      const relative = path.relative(root, target);
      if (isGeneratedArtifactPrunable(relative)) {
        const verifiedTarget = resolveInside(root, relative);
        await fs.rm(verifiedTarget, { recursive: entry.isDirectory(), force: true, maxRetries: 3, retryDelay: 100 });
        removed.push(normalizeRelativePath(relative));
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(target);
    }
  }

  try {
    await visit(root);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return removed;
}

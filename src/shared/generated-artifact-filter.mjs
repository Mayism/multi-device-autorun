import fs from "node:fs/promises";
import path from "node:path";

export const GENERATED_ARTIFACT_GIT_EXCLUDES = [
  ".onemulti/",
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
  if (parts.includes(".onemulti") || parts.includes("__pycache__")) return true;
  if (parts.at(-1)?.toLowerCase().endsWith(".pyc")) return true;
  return parts.some((part, index) => part === "evidence" && parts[index + 1] === "tmp");
}

function isGeneratedArtifactPrunable(relativePath) {
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
    if (section.length && !excluded) kept.push(...section);
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

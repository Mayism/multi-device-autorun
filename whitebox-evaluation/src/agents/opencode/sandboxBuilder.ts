import fs from "node:fs/promises";
import path from "node:path";
import { isIgnoredCaseFilePath } from "../../commons/utils/ignoredFiles.js";

export interface OpencodeSandbox {
  root: string;
  generatedRoot: string;
  originalRoot?: string;
  patchPath?: string;
  metadataRoot: string;
}

const IGNORED_ENTRY_NAMES = new Set([
  ".env",
  ".git",
  "node_modules",
  "oh_modules",
  ".hvigor",
  "build",
  "dist",
]);

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function shouldSkip(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => IGNORED_ENTRY_NAMES.has(part) || part.startsWith(".env."))) {
    return true;
  }
  return isIgnoredCaseFilePath(normalized);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function copyTree(input: { sourceRoot: string; targetRoot: string }): Promise<void> {
  const sourceRoot = path.resolve(input.sourceRoot);
  const targetRoot = path.resolve(input.targetRoot);
  const realSourceRoot = await fs.realpath(sourceRoot);

  async function visit(sourcePath: string): Promise<void> {
    const relativePath = path.relative(sourceRoot, sourcePath);
    if (relativePath && shouldSkip(relativePath)) {
      return;
    }

    const stat = await fs.lstat(sourcePath);
    if (stat.isSymbolicLink()) {
      const realTarget = await fs.realpath(sourcePath).catch(() => undefined);
      if (!realTarget || !isInsideRoot(realSourceRoot, realTarget)) {
        return;
      }
      const targetStat = await fs.stat(sourcePath);
      if (!targetStat.isFile()) {
        return;
      }
    }

    if (stat.isDirectory()) {
      const entries = await fs.readdir(sourcePath);
      await Promise.all(entries.map((entry) => visit(path.join(sourcePath, entry))));
      return;
    }

    if (!stat.isFile() && !stat.isSymbolicLink()) {
      return;
    }

    const targetPath = path.join(targetRoot, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }

  await fs.mkdir(targetRoot, { recursive: true });
  await visit(sourceRoot);
}

export async function buildOpencodeSandbox(input: {
  caseDir: string;
  generatedProjectPath: string;
  originalProjectPath?: string;
  originalProjectProvided?: boolean;
  effectivePatchPath?: string;
  metadata: Record<string, unknown>;
}): Promise<OpencodeSandbox> {
  const root = path.join(input.caseDir, "opencode-sandbox");
  const generatedRoot = path.join(root, "generated");
  const originalRoot = path.join(root, "original");
  const patchRoot = path.join(root, "patch");
  const metadataRoot = path.join(root, "metadata");

  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });

  await copyTree({ sourceRoot: input.generatedProjectPath, targetRoot: generatedRoot });

  let copiedOriginalRoot: string | undefined;
  if (
    input.originalProjectProvided !== false &&
    input.originalProjectPath &&
    (await pathExists(input.originalProjectPath))
  ) {
    await copyTree({ sourceRoot: input.originalProjectPath, targetRoot: originalRoot });
    copiedOriginalRoot = originalRoot;
  }

  let copiedPatchPath: string | undefined;
  if (input.effectivePatchPath && (await pathExists(input.effectivePatchPath))) {
    await fs.mkdir(patchRoot, { recursive: true });
    copiedPatchPath = path.join(patchRoot, "effective.patch");
    await fs.copyFile(input.effectivePatchPath, copiedPatchPath);
  }

  await fs.mkdir(metadataRoot, { recursive: true });
  await fs.writeFile(
    path.join(metadataRoot, "metadata.json"),
    `${JSON.stringify(input.metadata, null, 2)}\n`,
    "utf-8",
  );

  return {
    root,
    generatedRoot,
    originalRoot: copiedOriginalRoot,
    patchPath: copiedPatchPath,
    metadataRoot,
  };
}

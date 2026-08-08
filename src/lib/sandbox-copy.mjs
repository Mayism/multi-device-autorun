import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const COPY_EXCLUDES = new Set([".git", ".opencode", ".claude", ".agents", ".hvigor", "node_modules", "build"]);

function shouldCopy(sourcePath, sourceRoot) {
  const relative = path.relative(sourceRoot, sourcePath);
  if (!relative) return true;
  return !relative.split(path.sep).some((segment) => COPY_EXCLUDES.has(segment));
}

function relativeInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  if (!relative) return "";
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
  return relative;
}

async function pathExists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function createMappedLinks(links, sourceRoot, targetRoot) {
  let pending = [...links];

  while (pending.length) {
    const next = [];
    let created = 0;

    for (const link of pending) {
      const mappedTarget = path.join(targetRoot, link.targetRelative);
      await fs.mkdir(path.dirname(link.destination), { recursive: true });

      if (process.platform === "win32" && !await pathExists(mappedTarget)) {
        next.push(link);
        continue;
      }

      if (process.platform === "win32" && link.isDirectory) {
        // Windows Junction 不需要符号链接权限；目标必须落在本次沙箱内。
        await fs.symlink(mappedTarget, link.destination, "junction");
      } else if (process.platform === "win32") {
        // 普通文件符号链接通常仍要求额外权限，复制其内容更稳妥。
        await fs.copyFile(mappedTarget, link.destination);
      } else {
        const relativeTarget = path.relative(path.dirname(link.destination), mappedTarget) || ".";
        await fs.symlink(relativeTarget, link.destination, link.isDirectory ? "dir" : "file");
      }
      created += 1;
    }

    if (next.length && created === 0) {
      const unresolved = next.map((item) => path.relative(sourceRoot, item.source)).join(", ");
      throw new Error(`无法在沙箱内重建链接，目标不存在或形成循环: ${unresolved}`);
    }
    pending = next;
  }
}

/**
 * Copy a case into an isolated sandbox.
 * Internal directory links are remapped to the destination tree so the sandbox
 * never points back to the source case and Windows does not require symlink privilege.
 */
export async function copyProject(sourceRoot, targetRoot) {
  const absoluteSource = path.resolve(sourceRoot);
  const absoluteTarget = path.resolve(targetRoot);
  const links = [];

  await fs.rm(absoluteTarget, { recursive: true, force: true });
  await fs.cp(absoluteSource, absoluteTarget, {
    recursive: true,
    preserveTimestamps: true,
    filter: async (source) => {
      if (!shouldCopy(source, absoluteSource)) return false;

      const stat = await fs.lstat(source);
      if (!stat.isSymbolicLink()) return true;

      const rawTarget = await fs.readlink(source);
      const resolvedTarget = path.resolve(path.dirname(source), rawTarget);
      const targetRelative = relativeInside(absoluteSource, resolvedTarget);
      if (targetRelative === null) {
        throw new Error(
          `拒绝复制指向用例目录外部的链接: ${source} -> ${resolvedTarget}`,
        );
      }

      let targetStat;
      try {
        targetStat = await fs.stat(source);
      } catch (error) {
        throw new Error(`无法解析链接目标: ${source} -> ${resolvedTarget}`, { cause: error });
      }

      links.push({
        source,
        destination: path.join(absoluteTarget, path.relative(absoluteSource, source)),
        targetRelative,
        isDirectory: targetStat.isDirectory(),
      });
      return false;
    },
  });

  await createMappedLinks(links, absoluteSource, absoluteTarget);
  return { linksRemapped: links.length };
}

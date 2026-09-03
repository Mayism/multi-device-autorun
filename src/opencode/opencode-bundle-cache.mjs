import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

const BUNDLE_COMPLETE_MARKER = ".bundle-complete";
const BUNDLE_LOCK_FILE = ".bundle-cache.lock";
const STAGING_PREFIX = ".staging-autorun-";
const EXCLUDED_SOURCE_ENTRIES = new Set(["bin", "bundled-opencode.json"]);

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function directoryNonEmpty(target) {
  try {
    const stat = await fs.stat(target);
    return stat.isDirectory() && (await fs.readdir(target)).length > 0;
  } catch {
    return false;
  }
}

async function validateBundleDirectory(bundleDir, { requireCompleteMarker = true } = {}) {
  const missing = [];
  if (requireCompleteMarker && !await exists(path.join(bundleDir, BUNDLE_COMPLETE_MARKER))) {
    missing.push(BUNDLE_COMPLETE_MARKER);
  }
  if (!await exists(path.join(bundleDir, "opencode.json"))) missing.push("opencode.json");
  if (!await directoryNonEmpty(path.join(bundleDir, "plugin"))) missing.push("plugin/");
  if (!await directoryNonEmpty(path.join(bundleDir, "skills"))) missing.push("skills/");
  return missing;
}

function safeZipEntryPath(zipPath, entryName) {
  const normalized = String(entryName || "").replace(/\\/g, "/");
  if (
    !normalized
    || normalized.includes("\0")
    || path.posix.isAbsolute(normalized)
    || /^[A-Za-z]:/.test(normalized)
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.split("/").includes("..")
  ) {
    throw new Error(`ZIP ${zipPath} 包含不安全路径: ${entryName}`);
  }
  return normalized;
}

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, strictFileNames: false }, (error, zipFile) => {
      if (error) reject(error);
      else if (!zipFile) reject(new Error(`无法打开 ZIP: ${zipPath}`));
      else resolve(zipFile);
    });
  });
}

function openZipEntryStream(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else if (!stream) reject(new Error(`无法读取 ZIP 条目: ${entry.fileName}`));
      else resolve(stream);
    });
  });
}

async function extractZip(zipPath, targetDir) {
  const zipFile = await openZip(zipPath);
  await fs.mkdir(targetDir, { recursive: true });
  let files = 0;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      zipFile.close();
      reject(error);
    };
    zipFile.on("error", fail);
    zipFile.on("end", () => {
      if (settled) return;
      settled = true;
      zipFile.close();
      if (!files) reject(new Error(`ZIP 中没有可解压文件: ${zipPath}`));
      else resolve(files);
    });
    zipFile.on("entry", (entry) => {
      void (async () => {
        const entryName = safeZipEntryPath(zipPath, entry.fileName);
        const unixType = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (unixType === 0xa000) {
          zipFile.readEntry();
          return;
        }
        const targetPath = path.resolve(targetDir, ...entryName.split("/"));
        const resolvedRoot = path.resolve(targetDir);
        if (targetPath !== resolvedRoot && !targetPath.startsWith(`${resolvedRoot}${path.sep}`)) {
          throw new Error(`ZIP ${zipPath} 包含越界路径: ${entry.fileName}`);
        }
        if (entryName.endsWith("/")) {
          await fs.mkdir(targetPath, { recursive: true });
          zipFile.readEntry();
          return;
        }
        const stream = await openZipEntryStream(zipFile, entry);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        const handle = await fs.open(targetPath, "w");
        try {
          await pipeline(stream, handle.createWriteStream());
        } finally {
          await handle.close().catch(() => {});
        }
        if (process.platform !== "win32") {
          const mode = (entry.externalFileAttributes >>> 16) & 0o777;
          if (mode) await fs.chmod(targetPath, mode).catch(() => {});
        }
        files += 1;
        zipFile.readEntry();
      })().catch(fail);
    });
    zipFile.readEntry();
  });
}

async function copyBundleSource(sourceDir, stagingDir) {
  await fs.cp(sourceDir, stagingDir, {
    recursive: true,
    filter(sourcePath) {
      const relative = path.relative(sourceDir, sourcePath);
      if (!relative) return true;
      return !EXCLUDED_SOURCE_ENTRIES.has(relative.split(path.sep)[0]);
    },
  });
}

async function materializeBundle(sourceDir, stagingDir) {
  await copyBundleSource(sourceDir, stagingDir);
  const skillsZip = path.join(stagingDir, "skills.zip");
  if (await exists(skillsZip)) {
    await extractZip(skillsZip, path.join(stagingDir, "skills"));
    await fs.rm(skillsZip, { force: true });
  }
  const pluginZip = path.join(stagingDir, "plugin", "hmos-library-adapter-fast.zip");
  if (await exists(pluginZip)) {
    await extractZip(pluginZip, path.join(stagingDir, "plugin", "hmos-library-adapter-fast"));
    await fs.rm(pluginZip, { force: true });
  }
  const missing = await validateBundleDirectory(stagingDir, { requireCompleteMarker: false });
  if (missing.length) {
    throw new Error(`解压后的 Bundle 不完整（缺少 ${missing.join("、")}）`);
  }
  await fs.writeFile(path.join(stagingDir, BUNDLE_COMPLETE_MARKER), "ok\n", "utf8");
}

async function acquireBundleLock(lockPath, cacheDir, { timeoutMs = 60_000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let handle;
    try {
      handle = await fs.open(lockPath, "wx");
      await handle.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8");
      await handle.close();
      return true;
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        await fs.rm(lockPath, { force: true }).catch(() => {});
      }
      if (error?.code !== "EEXIST") throw error;
      if (!(await validateBundleDirectory(cacheDir)).length) return false;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > timeoutMs) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  if (!(await validateBundleDirectory(cacheDir)).length) return false;
  throw new Error(`等待 Bundle 缓存锁超时: ${lockPath}`);
}

export async function ensureHarmonyBotBundle({
  sourceDir,
  bundleHash,
  cacheRoot,
  lockTimeoutMs,
}) {
  const normalizedHash = String(bundleHash || "").trim();
  if (!/^[a-f0-9]{16,64}$/i.test(normalizedHash)) {
    throw new Error(`无效的 .bundle-hash: ${normalizedHash || "<empty>"}`);
  }
  const resolvedCacheRoot = path.resolve(cacheRoot);
  const cacheDir = path.join(resolvedCacheRoot, normalizedHash);
  if (!(await validateBundleDirectory(cacheDir)).length) {
    return { bundleDir: cacheDir, status: "cached" };
  }

  await fs.mkdir(resolvedCacheRoot, { recursive: true });
  const lockPath = path.join(resolvedCacheRoot, BUNDLE_LOCK_FILE);
  const ownsLock = await acquireBundleLock(lockPath, cacheDir, { timeoutMs: lockTimeoutMs });
  if (!ownsLock) return { bundleDir: cacheDir, status: "cached" };

  const stagingDir = path.join(
    resolvedCacheRoot,
    `${STAGING_PREFIX}${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  try {
    if (!(await validateBundleDirectory(cacheDir)).length) {
      return { bundleDir: cacheDir, status: "cached" };
    }
    await fs.rm(stagingDir, { recursive: true, force: true });
    await materializeBundle(path.resolve(sourceDir), stagingDir);
    await fs.rm(cacheDir, { recursive: true, force: true });
    await fs.rename(stagingDir, cacheDir);
    return { bundleDir: cacheDir, status: "prepared" };
  } catch (error) {
    throw new Error(
      `无法准备 HarmonyBot OpenCode Bundle ${normalizedHash}: ${error.message}`,
      { cause: error },
    );
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

export async function bundleDirectoryIsHealthy(bundleDir) {
  return !(await validateBundleDirectory(bundleDir)).length;
}

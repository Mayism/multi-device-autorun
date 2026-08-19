// zip.mjs
// 创建 ZIP 归档（DEFLATE 压缩），用于上传失败用例产物。
// 纯 Node.js 实现，零第三方依赖。

import fs from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { isGeneratedArtifactExcluded } from "./generated-artifact-filter.mjs";

// ─── CRC32 ──────────────────────────────────────────────────────
const crcTable = [];
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[i] = c;
}
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ─── 打包过滤（排除构建产物和缓存） ────────────────────────────
const EXCLUDE_DIRS = new Set(["build", ".hvigor", "oh_modules", "node_modules", ".opencode", ".git", ".ohpm"]);
const EXCLUDE_FILES = new Set(["opencode.json", "oh-package-lock.json5"]);

function shouldExclude(relPath) {
  const parts = relPath.split(/[\\/]/);
  if (isGeneratedArtifactExcluded(relPath)) return true;
  if (parts.some((p) => EXCLUDE_DIRS.has(p))) return true;
  if (EXCLUDE_FILES.has(parts[parts.length - 1])) return true;
  return false;
}

// 递归收集目录下所有文件，返回 [{ absPath, zipPath }]
async function walkDir(dirPath, prefix = "") {
  const entries = [];
  let items;
  try {
    items = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const item of items) {
    const relPath = prefix ? `${prefix}/${item.name}` : item.name;
    if (shouldExclude(relPath)) continue;
    const fullPath = path.join(dirPath, item.name);
    if (item.isDirectory()) {
      entries.push(...await walkDir(fullPath, relPath));
    } else if (item.isFile()) {
      entries.push({ absPath: fullPath, zipPath: relPath });
    }
  }
  return entries;
}

/**
 * 创建 ZIP 归档。
 * @param {Array<{dirPath: string, prefix?: string} | {absPath: string, zipPath: string}>} sources
 *   - {dirPath, prefix}：递归收集整个目录，prefix 为 zip 内的根目录名
 *   - {absPath, zipPath}：单个文件
 * @returns {Promise<Uint8Array>} ZIP 字节
 */
export async function createZip(sources) {
  const fileEntries = [];
  for (const src of sources) {
    if (src.dirPath) {
      const walked = await walkDir(src.dirPath, src.prefix || "");
      fileEntries.push(...walked);
    } else if (src.absPath) {
      fileEntries.push(src);
    }
  }

  const enc = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;

  for (const entry of fileEntries) {
    const raw = await fs.readFile(entry.absPath);
    const data = new Uint8Array(raw);
    const nameB = enc.encode(entry.zipPath);
    const compressed = deflateRawSync(data);
    const crc = crc32(data);

    // Local file header (30 + name)
    const lh = new Uint8Array(30 + nameB.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(8, 8, true); // deflate
    dv.setUint32(14, crc, true);
    dv.setUint32(18, compressed.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameB.length, true);
    lh.set(nameB, 30);
    local.push(lh, compressed);

    // Central directory header (46 + name)
    const ch = new Uint8Array(46 + nameB.length);
    const cdv = new DataView(ch.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(10, 8, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, compressed.length, true);
    cdv.setUint32(24, data.length, true);
    cdv.setUint16(28, nameB.length, true);
    cdv.setUint32(42, offset, true);
    ch.set(nameB, 46);
    central.push(ch);

    offset += lh.length + compressed.length;
  }

  const localSize = local.reduce((s, p) => s + p.length, 0);
  const centralSize = central.reduce((s, p) => s + p.length, 0);

  // End of central directory
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, fileEntries.length, true);
  edv.setUint16(10, fileEntries.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, localSize, true);

  const all = [...local, ...central, eocd];
  const total = all.reduce((s, p) => s + p.length, 0);
  const zip = new Uint8Array(total);
  let pos = 0;
  for (const p of all) { zip.set(p, pos); pos += p.length; }
  return zip;
}

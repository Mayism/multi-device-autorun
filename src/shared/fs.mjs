import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";

export function safeName(value) {
  return String(value || "case").replace(/[^0-9A-Za-z._-]+/g, "_").slice(0, 120) || "case";
}

export async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

export async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

export async function readJson(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return null; }
}


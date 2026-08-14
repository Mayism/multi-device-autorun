import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runnerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("runner modes depend only on the neutral execution core", async () => {
  assert.deepEqual(await importsAcross("case", "matrix"), []);
  assert.deepEqual(await importsAcross("matrix", "case"), []);
  assert.deepEqual(await importsAcross("execution", "case"), []);
  assert.deepEqual(await importsAcross("execution", "matrix"), []);
});

async function importsAcross(
  sourceArea: string,
  forbiddenArea: string,
): Promise<string[]> {
  const sourceRoot = path.join(runnerRoot, "src", sourceArea);
  const files = await typescriptFiles(sourceRoot);
  const violations: string[] = [];
  for (const file of files) {
    const source = await fs.readFile(file, "utf-8");
    for (const match of source.matchAll(
      /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g,
    )) {
      const specifier = match[1]!;
      if (!specifier.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(file), specifier);
      const forbiddenRoot = path.join(runnerRoot, "src", forbiddenArea);
      if (
        resolved === forbiddenRoot ||
        resolved.startsWith(`${forbiddenRoot}${path.sep}`)
      ) {
        violations.push(`${path.relative(runnerRoot, file)} -> ${specifier}`);
      }
    }
  }
  return violations.sort();
}

async function typescriptFiles(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, {
      withFileTypes: true,
      encoding: "utf-8",
    });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await typescriptFiles(fullPath)));
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(fullPath);
      }
    }
    return files;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

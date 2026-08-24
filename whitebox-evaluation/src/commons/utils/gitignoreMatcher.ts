import fs from "node:fs/promises";
import path from "node:path";
import { isIgnoredCaseFilePath } from "./ignoredFiles.js";

const BUILTIN_EXACT_NAMES = new Set([
  ".git",
  ".gitignore",
  ".agent_bench",
  ".DS_Store",
  ".hvigor",
  "__MACOSX",
  "build",
  "node_modules",
  "oh_modules",
  "oh-package-lock.json5",
]);

type EntryKind = "file" | "directory";

type Rule =
  | { type: "exact"; value: string }
  | { type: "prefix"; value: string }
  | { type: "suffix"; value: string }
  | { type: "wildcard"; value: string; regex: RegExp; hasSlash: boolean; directoryOnly: boolean };

export interface IgnoreFilter {
  isIgnored(relativePath: string, kind: EntryKind): boolean;
}

// CollectVisibleFilesOptions 允许调用方按场景注入额外忽略目录，而不污染全局默认规则。
export interface CollectVisibleFilesOptions {
  extraIgnoredPathPrefixes?: string[];
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function containsBuiltinIgnoredDirectory(relativePath: string, kind: EntryKind): boolean {
  const normalized = normalizeRelativePath(relativePath);
  const segments = normalized.split("/").filter(Boolean);
  const directorySegments = kind === "directory" ? segments : segments.slice(0, -1);
  if (directorySegments.some((segment) => segment.startsWith("."))) {
    return true;
  }
  return directorySegments.some(
    (segment, index) =>
      segment === "src" && ["test", "ohosTest"].includes(directorySegments[index + 1] ?? ""),
  );
}

function toRule(pattern: string): Rule | null {
  const trimmed = pattern.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!") || trimmed.includes("**")) {
    return null;
  }
  const directoryOnly = trimmed.endsWith("/");
  const normalizedPattern = directoryOnly ? trimmed.slice(0, -1) : trimmed;
  if (!normalizedPattern) {
    return null;
  }
  if (trimmed.startsWith("*.")) {
    return { type: "suffix", value: trimmed.slice(1) };
  }
  if (normalizedPattern.includes("*")) {
    const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    return {
      type: "wildcard",
      value: normalizedPattern,
      regex: new RegExp(`^${escaped.replace(/\*/g, "[^/]*")}$`),
      hasSlash: normalizedPattern.includes("/"),
      directoryOnly,
    };
  }
  if (directoryOnly) {
    return { type: "prefix", value: normalizedPattern };
  }
  return { type: "exact", value: trimmed };
}

function matchesRule(rule: Rule, relativePath: string, kind: EntryKind): boolean {
  const normalized = normalizeRelativePath(relativePath);
  const segments = normalized.split("/");
  if (rule.type === "suffix") {
    return kind === "file" && normalized.endsWith(rule.value);
  }
  if (rule.type === "prefix") {
    return (
      normalized === rule.value ||
      normalized.startsWith(`${rule.value}/`) ||
      segments.includes(rule.value)
    );
  }
  if (rule.type === "wildcard") {
    if (rule.directoryOnly) {
      const directorySegments = kind === "directory" ? segments : segments.slice(0, -1);
      if (rule.hasSlash) {
        let currentPath = "";
        for (const segment of directorySegments) {
          currentPath = currentPath ? `${currentPath}/${segment}` : segment;
          if (rule.regex.test(currentPath)) {
            return true;
          }
        }
        return false;
      }
      return directorySegments.some((segment) => rule.regex.test(segment));
    }
    if (rule.hasSlash) {
      return rule.regex.test(normalized);
    }
    return segments.some((segment) => rule.regex.test(segment));
  }
  return normalized === rule.value || segments.includes(rule.value);
}

async function loadRules(rootDir: string): Promise<Rule[]> {
  const rules: Rule[] = [];
  const gitignorePath = path.join(rootDir, ".gitignore");
  try {
    const text = await fs.readFile(gitignorePath, "utf-8");
    for (const line of text.split(/\r?\n/)) {
      const rule = toRule(line);
      if (rule) {
        rules.push(rule);
      }
    }
  } catch {
    // missing or unreadable gitignore falls back to builtin ignores only
  }
  return rules;
}

export async function loadIgnoreFilter(
  rootDir: string,
  options: CollectVisibleFilesOptions = {},
): Promise<IgnoreFilter> {
  const rules = await loadRules(rootDir);
  const extraIgnoredPathPrefixes = (options.extraIgnoredPathPrefixes ?? [])
    .map((item) => normalizeRelativePath(item).replace(/\/+$/, ""))
    .filter(Boolean);
  return {
    isIgnored(relativePath: string, kind: EntryKind): boolean {
      const normalized = normalizeRelativePath(relativePath);
      const segments = normalized.split("/");
      if (containsBuiltinIgnoredDirectory(normalized, kind)) {
        return true;
      }
      if (segments.some((segment) => BUILTIN_EXACT_NAMES.has(segment))) {
        return true;
      }
      if (kind === "file" && segments.some((segment) => segment.startsWith("._"))) {
        return true;
      }
      if (kind === "file" && isIgnoredCaseFilePath(normalized)) {
        return true;
      }
      if (
        extraIgnoredPathPrefixes.some(
          (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
        )
      ) {
        return true;
      }
      if (kind === "file" && normalized.endsWith(".log")) {
        return true;
      }
      return rules.some((rule) => matchesRule(rule, normalized, kind));
    },
  };
}

async function collectVisibleFilesFrom(
  rootDir: string,
  currentDir: string,
  filter: IgnoreFilter,
): Promise<string[]> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = normalizeRelativePath(path.relative(rootDir, absolutePath));
    if (filter.isIgnored(relativePath, entry.isDirectory() ? "directory" : "file")) {
      continue;
    }
    if (entry.isDirectory()) {
      results.push(...(await collectVisibleFilesFrom(rootDir, absolutePath, filter)));
      continue;
    }
    if (entry.isFile()) {
      results.push(relativePath);
    }
  }
  return results;
}

export async function collectVisibleFiles(
  rootDir: string,
  options: CollectVisibleFilesOptions = {},
): Promise<string[]> {
  const filter = await loadIgnoreFilter(rootDir, options);
  const files = await collectVisibleFilesFrom(rootDir, rootDir, filter);
  return files.sort();
}

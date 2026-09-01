import { isIgnoredCaseFilePath } from "../../commons/utils/ignoredFiles.js";

export interface PatchScope {
  changedFiles: string[];
  addedLineNumbersByFile: Map<string, number[]>;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/^workspace\//, "").replace(/^original\//, "");
}

// 从 unified diff 中提取变更文件和新增行号，供规则只聚焦本次改动范围。
export function parsePatchScope(patchText: string | undefined): PatchScope {
  if (!patchText) {
    return {
      changedFiles: [],
      addedLineNumbersByFile: new Map(),
    };
  }

  const changedFiles = new Set<string>();
  const addedLineNumbersByFile = new Map<string, number[]>();
  let currentFile: string | undefined;
  let nextNewLineNumber: number | undefined;

  function registerFile(relativePath: string): void {
    if (!relativePath || relativePath === "/dev/null") {
      return;
    }

    const normalizedPath = normalizeRelativePath(relativePath);
    if (!normalizedPath || isIgnoredCaseFilePath(normalizedPath)) {
      currentFile = undefined;
      return;
    }

    currentFile = normalizedPath;
    changedFiles.add(normalizedPath);
    if (!addedLineNumbersByFile.has(normalizedPath)) {
      addedLineNumbersByFile.set(normalizedPath, []);
    }
  }

  for (const line of patchText.split(/\r?\n/)) {
    const diffMatch = /^diff --git a\/.+? b\/(.+)$/.exec(line);
    if (diffMatch?.[1]) {
      registerFile(diffMatch[1]);
      nextNewLineNumber = undefined;
      continue;
    }

    const newFileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (newFileMatch?.[1]) {
      registerFile(newFileMatch[1]);
      continue;
    }

    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch?.[1]) {
      nextNewLineNumber = Number(hunkMatch[1]);
      continue;
    }

    if (!currentFile || nextNewLineNumber === undefined) {
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      addedLineNumbersByFile.get(currentFile)?.push(nextNewLineNumber);
      nextNewLineNumber += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    } else if (!line.startsWith("\\")) {
      nextNewLineNumber += 1;
    }
  }

  return {
    changedFiles: [...changedFiles],
    addedLineNumbersByFile,
  };
}

export const IGNORED_FILE_NAMES = new Set(["BuildProfile.ets"]);

function normalizeFilePath(filePath: string): string {
  return filePath
    .split("\\")
    .join("/")
    .replace(/^\.\/+/, "");
}

export function isIgnoredCaseFilePath(filePath: string): boolean {
  const normalized = normalizeFilePath(filePath);
  const parts = normalized.split("/").filter(Boolean);
  const fileName = parts.at(-1) ?? normalized;
  if (IGNORED_FILE_NAMES.has(fileName)) {
    return true;
  }
  if (parts.includes(".onemulti") || parts.includes("__pycache__")) {
    return true;
  }
  if (fileName.toLowerCase().endsWith(".pyc")) {
    return true;
  }
  return parts.some((part, index) => part === "evidence" && parts[index + 1] === "tmp");
}

function lineReferencesIgnoredFile(line: string): boolean {
  const diffMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  if (diffMatch) {
    return [diffMatch[1], diffMatch[2]].some((item) =>
      item ? isIgnoredCaseFilePath(item) : false,
    );
  }

  const markerMatch = /^(?:---|\+\+\+) (?:a|b)\/(.+)$/.exec(line);
  if (markerMatch?.[1]) {
    return isIgnoredCaseFilePath(markerMatch[1]);
  }

  return false;
}

export function filterPatchTextForIgnoredFiles(patchText: string): string {
  if (!patchText.includes("diff --git")) {
    return patchText;
  }

  const hasTrailingNewline = patchText.endsWith("\n");
  const lines = (hasTrailingNewline ? patchText.slice(0, -1) : patchText).split("\n");
  const sections: Array<{ lines: string[]; ignored: boolean }> = [];
  let currentLines: string[] = [];
  let currentIgnored = false;

  function pushCurrentSection(): void {
    if (currentLines.length === 0) {
      return;
    }
    sections.push({ lines: currentLines, ignored: currentIgnored });
    currentLines = [];
    currentIgnored = false;
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      pushCurrentSection();
    }

    currentLines.push(line);
    if (lineReferencesIgnoredFile(line)) {
      currentIgnored = true;
    }
  }

  pushCurrentSection();

  const keptLines = sections
    .filter((section) => !section.ignored)
    .flatMap((section) => section.lines);
  if (keptLines.length === 0) {
    return "";
  }

  return `${keptLines.join("\n")}${hasTrailingNewline ? "\n" : ""}`;
}

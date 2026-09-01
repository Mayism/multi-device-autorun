import fs from "node:fs/promises";
import path from "node:path";

const CASE_DIR_KEEP_ENTRIES = new Set(["inputs", "outputs", "logs", "metadata", "opencode-sandbox"]);
const OPENCODE_SANDBOX_KEEP_ENTRIES = new Set(["metadata", "patch"]);
const INTERMEDIATE_CODE_LINTER_KEEP_ENTRIES = new Set([
  "summary.json",
  "findings.effective.json",
  "hvigor-summary.json",
]);

type PruneCompletedCaseArtifactsOptions = {
  keepCodeLinterDiagnostics?: boolean;
};

async function pruneDirectoryChildren(root: string, keepEntries: Set<string>): Promise<void> {
  let entries: Array<{ name: string }>;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return;
    }
    throw error;
  }

  await Promise.all(
    entries
      .filter((entry) => !keepEntries.has(entry.name))
      .map((entry) => fs.rm(path.join(root, entry.name), { recursive: true, force: true })),
  );
}

export async function pruneCompletedCaseArtifacts(
  caseDir: string,
  options: PruneCompletedCaseArtifactsOptions = {},
): Promise<void> {
  const caseDirKeepEntries = options.keepCodeLinterDiagnostics
    ? new Set([...CASE_DIR_KEEP_ENTRIES, "intermediate"])
    : CASE_DIR_KEEP_ENTRIES;
  await pruneDirectoryChildren(caseDir, caseDirKeepEntries);
  if (options.keepCodeLinterDiagnostics) {
    await pruneDirectoryChildren(path.join(caseDir, "intermediate"), new Set(["code-linter"]));
    await pruneDirectoryChildren(
      path.join(caseDir, "intermediate", "code-linter"),
      INTERMEDIATE_CODE_LINTER_KEEP_ENTRIES,
    );
  }
  await pruneDirectoryChildren(
    path.join(caseDir, "opencode-sandbox"),
    OPENCODE_SANDBOX_KEEP_ENTRIES,
  );
}

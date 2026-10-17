import fs from "node:fs/promises";
import path from "node:path";

export const TRANSIENT_CASE_FILES = ["result.json", "state.json", "session.json"];
export const OMITTED_GENERATE_FILES = ["input.txt", "last-message.json", "skill-runtime.json", "output.txt", "final-message.json"];

function caseDirectoryName(value) {
  const name = String(value || "case").replace(/[^0-9A-Za-z._-]+/g, "_").slice(0, 120);
  return name && name !== "." && name !== ".." ? name : "case";
}

// summary.json 已成功落盘后调用；运行中仍需这些文件供后置阶段和中断恢复读取。
export async function cleanupCaseMetadata({ batchRoot, summary }) {
  await fs.access(path.join(batchRoot, "summary.json"));
  const failures = [];
  const caseNames = new Set((Array.isArray(summary?.results) ? summary.results : [])
    .map((result) => result?.case).filter((name) => typeof name === "string" && name));
  for (const caseName of caseNames) {
    const caseDir = path.join(batchRoot, caseDirectoryName(caseName));
    for (const name of TRANSIENT_CASE_FILES) {
      try {
        await fs.rm(path.join(caseDir, name), { force: true });
      } catch (error) {
        failures.push(`${caseName}/${name}: ${error.message}`);
      }
    }
    for (const name of OMITTED_GENERATE_FILES) {
      try {
        await fs.rm(path.join(caseDir, "generate", name), { force: true });
      } catch (error) {
        failures.push(`${caseName}/generate/${name}: ${error.message}`);
      }
    }
  }
  return failures;
}

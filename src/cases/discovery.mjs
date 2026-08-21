import fs from "node:fs/promises";
import path from "node:path";
import { exists } from "../shared/fs.mjs";

export async function discoverCases(casesRoot, { requireOhosTest = false } = {}) {
  if (!await exists(casesRoot)) throw new Error(`casesRoot 不存在: ${casesRoot}`);
  const entries = await fs.readdir(casesRoot, { withFileTypes: true });
  const runnable = [];
  const skipped = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const caseRoot = path.join(casesRoot, entry.name);
    const promptPath = path.join(caseRoot, "PROMPT.md");
    const issues = [];
    let projectName = "";
    let projectDir = "";
    const invalidProjectNames = [];
    for (const candidate of ["base", "task"]) {
      const candidateDir = path.join(caseRoot, candidate);
      try {
        const stat = await fs.stat(candidateDir);
        if (stat.isDirectory()) {
          if (!projectName) {
            projectName = candidate;
            projectDir = candidateDir;
          }
        } else {
          invalidProjectNames.push(`${candidate} 不是目录`);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") invalidProjectNames.push(`${candidate} 无法访问`);
      }
    }
    if (!projectName) {
      issues.push(invalidProjectNames.length
        ? invalidProjectNames.join("；")
        : "缺少 base/ 或 task/ 工程目录");
    }
    try {
      const prompt = await fs.readFile(promptPath, "utf8");
      if (!prompt.trim()) issues.push("PROMPT.md 为空");
    } catch {
      issues.push("缺少 PROMPT.md");
    }
    if (requireOhosTest) {
      const metadataPath = path.join(caseRoot, "metadata.json");
      let metadata;
      try {
        metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
      } catch {
        issues.push("缺少或无法解析 metadata.json");
      }
      if (metadata) {
        for (const field of ["base_project", "test_patch", "golden_patch"]) {
          if (!metadata[field]) issues.push(`metadata.json 缺少 ${field}`);
        }
        for (const field of ["test_patch", "golden_patch"]) {
          const relative = String(metadata[field] || "").trim();
          if (relative && !await exists(path.join(caseRoot, relative))) {
            issues.push(`缺少 ${relative}`);
          }
        }
        if (projectDir && metadata.base_project) {
          const configuredProject = path.resolve(caseRoot, String(metadata.base_project));
          if (configuredProject !== path.resolve(projectDir)) {
            issues.push(`metadata.base_project 必须指向实际工程 ${projectName}`);
          }
        }
      }
    }
    const item = { name: entry.name, caseRoot, projectName, projectDir, promptPath };
    if (issues.length) skipped.push({ ...item, skipReason: issues.join("；") });
    else runnable.push(item);
  }
  if (!runnable.length) {
    const details = skipped.map((item) => `${item.name}: ${item.skipReason}`).join("；");
    throw new Error(`未发现可执行用例${details ? `（${details}）` : ""}`);
  }
  return { runnable, skipped };
}



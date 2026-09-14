import fs from "node:fs/promises";
import path from "node:path";
import { copyProject } from "./sandbox-copy.mjs";

export function normalizeCasePlatform(metadata) {
  return String(metadata?.platform || "native").trim().toLowerCase() || "native";
}

export function agentCaseLayout(caseInfo, caseRunDir) {
  const platform = String(caseInfo.platform || "native").trim().toLowerCase() || "native";
  const web = platform === "web";
  const projectDir = web
    ? path.join(caseRunDir, "project")
    : path.join(caseRunDir, caseInfo.projectName);
  return {
    platform,
    web,
    originalDir: path.join(caseRunDir, "original"),
    projectDir,
    buildProjectDir: web ? path.join(projectDir, caseInfo.projectName) : projectDir,
  };
}

export async function copyCaseSourceSnapshot(caseInfo, destination) {
  if (String(caseInfo.platform || "native").toLowerCase() !== "web") {
    await copyProject(caseInfo.projectDir, destination);
    return;
  }
  if (!caseInfo.webProjectDir) throw new Error(`Web 用例 ${caseInfo.name} 缺少 web 工程目录`);
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  await copyProject(caseInfo.projectDir, path.join(destination, caseInfo.projectName));
  await copyProject(caseInfo.webProjectDir, path.join(destination, "web"));
}

export async function prepareAgentCaseWorkspace(caseInfo, layout) {
  await copyCaseSourceSnapshot(caseInfo, layout.originalDir);
  await copyProject(layout.originalDir, layout.projectDir);
}

export async function materializeAgentCaseProjects(caseInfo, layout, caseRunDir) {
  if (!layout.web) return;
  await copyProject(
    path.join(layout.projectDir, caseInfo.projectName),
    path.join(caseRunDir, caseInfo.projectName),
  );
  await copyProject(path.join(layout.projectDir, "web"), path.join(caseRunDir, "web"));
}

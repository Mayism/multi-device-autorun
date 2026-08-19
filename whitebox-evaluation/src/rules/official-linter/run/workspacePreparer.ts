import fs from "node:fs/promises";
import path from "node:path";
import { collectVisibleFiles } from "../../../commons/utils/gitignoreMatcher.js";
import { writeOfficialCodeLinterConfig } from "../config/configWriter.js";

export interface OfficialCodeLinterWorkspace {
  workspaceDir: string;
  configPath: string;
  workspaceConfigPath: string;
  copiedFiles: string[];
}

export async function prepareOfficialCodeLinterWorkspace(input: {
  generatedProjectPath: string;
  caseDir: string;
  ruleSets?: string[];
}): Promise<OfficialCodeLinterWorkspace> {
  const artifactDir = path.join(input.caseDir, "intermediate", "code-linter");
  const workspaceDir = path.join(artifactDir, "workspace");
  await fs.rm(workspaceDir, { recursive: true, force: true });
  await fs.mkdir(workspaceDir, { recursive: true });

  const copiedFiles = await collectVisibleFiles(input.generatedProjectPath, {
    extraIgnoredPathPrefixes: [
      "node_modules",
      "oh_modules",
      "build",
      ".preview",
      ".git",
      "src/ohosTest",
      "src/test",
    ],
  });

  for (const relativePath of copiedFiles) {
    const sourcePath = path.join(input.generatedProjectPath, relativePath);
    const targetPath = path.join(workspaceDir, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }

  const configPath = await writeOfficialCodeLinterConfig(
    path.join(artifactDir, "code-linter.json5"),
    {
      ruleSets: input.ruleSets,
    },
  );
  const workspaceConfigPath = path.join(workspaceDir, "code-linter.json5");
  await fs.copyFile(configPath, workspaceConfigPath);

  return {
    workspaceDir,
    configPath,
    workspaceConfigPath,
    copiedFiles,
  };
}

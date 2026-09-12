import fs from "node:fs/promises";
import path from "node:path";
import { copyBaseProject } from "./patch.js";
import type { CaseMetadata } from "./types/index.js";

export interface CaseWorkspace {
  patchRoot: string;
  workProject: string;
  webProject?: string;
}

export function caseWorkspace(
  metadata: CaseMetadata,
  outDir: string,
): CaseWorkspace {
  const patchRoot = path.join(outDir, "work", "project");
  if (metadata.platform !== "web") return { patchRoot, workProject: patchRoot };
  const baseRelative = path.relative(metadata.caseDir, metadata.baseProject);
  const webSource = path.join(metadata.caseDir, "web");
  if (
    !baseRelative ||
    !inside(metadata.caseDir, metadata.baseProject) ||
    inside(webSource, metadata.baseProject) ||
    inside(metadata.baseProject, webSource)
  ) {
    throw new Error(
      "case_web_base_invalid: base_project must be inside the Case and separate from web",
    );
  }
  for (const source of [metadata.baseProject, webSource]) {
    if (inside(source, patchRoot) || inside(patchRoot, source)) {
      throw new Error("case_web_output_overlaps_source");
    }
  }
  return {
    patchRoot,
    workProject: path.join(patchRoot, baseRelative),
    webProject: path.join(patchRoot, "web"),
  };
}

export async function prepareCaseWorkspace(
  metadata: CaseMetadata,
  layout: CaseWorkspace,
): Promise<void> {
  if (!layout.webProject) {
    await copyBaseProject({
      baseProject: metadata.baseProject,
      workProject: layout.workProject,
    });
    return;
  }
  const webSource = path.join(metadata.caseDir, "web");
  if (!(await fs.stat(webSource).catch(() => undefined))?.isDirectory()) {
    throw new Error("case_web_project_missing: web");
  }
  await fs.rm(layout.patchRoot, { recursive: true, force: true });
  await copyBaseProject({
    baseProject: metadata.baseProject,
    workProject: layout.workProject,
  });
  await copyBaseProject({
    baseProject: webSource,
    workProject: layout.webProject,
  });
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

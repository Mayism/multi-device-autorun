import fs from "node:fs/promises";
import path from "node:path";
import { generateCasePatch } from "../../commons/io/patchGenerator.js";
import { filterPatchTextForIgnoredFiles } from "../../commons/utils/ignoredFiles.js";
import type { CaseInput, EvidenceSummary } from "../../types.js";
import { collectEvidence } from "./collectEvidence.js";

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function preparePatchEvidenceSummary(input: {
  caseInput: CaseInput;
  caseDir: string;
}): Promise<{
  caseInput: CaseInput;
  effectivePatchPath?: string;
  evidenceSummary: EvidenceSummary;
}> {
  let effectivePatchPath = input.caseInput.patchPath;

  if (effectivePatchPath) {
    const patchText = filterPatchTextForIgnoredFiles(
      await fs.readFile(effectivePatchPath, "utf-8").catch(() => ""),
    );
    if (patchText.trim().length > 0) {
      const outputPath = path.join(input.caseDir, "intermediate", "effective.patch");
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, patchText, "utf-8");
      effectivePatchPath = outputPath;
    }
  }

  if (!effectivePatchPath || !(await pathExists(effectivePatchPath))) {
    if (!(await pathExists(input.caseInput.originalProjectPath))) {
      await fs.mkdir(input.caseInput.originalProjectPath, { recursive: true });
    }
    const outputPath = path.join(input.caseDir, "intermediate", "generated.patch");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const caseRoot = path.dirname(input.caseInput.originalProjectPath);
    effectivePatchPath = await generateCasePatch(caseRoot, outputPath);
  }

  const caseInput = {
    ...input.caseInput,
    patchPath: effectivePatchPath,
  };
  const evidence = await collectEvidence(caseInput);
  return {
    caseInput,
    effectivePatchPath,
    evidenceSummary: evidence.summary,
  };
}

import fs from "node:fs/promises";
import path from "node:path";
import type { HumanRatingAnalysisRecord, HumanRatingRecord } from "./humanRatingTypes.js";

type HumanRatingSkippedRecord = HumanRatingRecord & {
  analysisStatus: "skipped";
  skipReason: string;
};

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function removeIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function humanRatingPath(caseDir: string, fileName: string): string {
  return path.join(caseDir, "human-rating", fileName);
}

export async function writeHumanRatingRecord(
  caseDir: string,
  record: HumanRatingRecord,
): Promise<void> {
  await writeJson(humanRatingPath(caseDir, "manual-rating.json"), record);
  await removeIfExists(humanRatingPath(caseDir, "manual-rating-history.jsonl"));
}

export async function writeHumanRatingSkipped(
  caseDir: string,
  record: HumanRatingRecord,
  skipReason: string,
): Promise<void> {
  const skipped: HumanRatingSkippedRecord = {
    ...record,
    analysisStatus: "skipped",
    skipReason,
  };
  await writeJson(humanRatingPath(caseDir, "analysis-skipped.json"), skipped);
  await removeIfExists(humanRatingPath(caseDir, "analysis.json"));
  await removeIfExists(humanRatingPath(caseDir, "analysis-history.jsonl"));
}

export async function writeHumanRatingAnalysis(
  caseDir: string,
  record: HumanRatingAnalysisRecord,
): Promise<void> {
  await writeJson(humanRatingPath(caseDir, "analysis.json"), record);
  await removeIfExists(humanRatingPath(caseDir, "analysis-skipped.json"));
  await removeIfExists(humanRatingPath(caseDir, "analysis-history.jsonl"));
}

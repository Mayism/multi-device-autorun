import fs from "node:fs/promises";
import path from "node:path";
import type { HumanReviewDatasetSample, HumanReviewDatasetType } from "./humanReviewTypes.js";

export type HumanReviewEvidenceStore = {
  appendDatasetSample(
    datasetType: HumanReviewDatasetType,
    sample: HumanReviewDatasetSample,
  ): Promise<string>;
  upsertDatasetSample(
    datasetType: HumanReviewDatasetType,
    sample: HumanReviewDatasetSample,
    match: Record<string, unknown>,
  ): Promise<string>;
  deleteDatasetSamples(
    datasetType: HumanReviewDatasetType,
    match: Record<string, unknown>,
  ): Promise<string>;
};

const DATASET_FILE_NAMES: Record<HumanReviewDatasetType, string> = {
  item_review_calibration: "item_review_calibrations.jsonl",
  risk_review_calibration: "risk_review_calibrations.jsonl",
  human_rating_gap_analysis: "human_rating_gap_analyses.jsonl",
};

export function createHumanReviewEvidenceStore(root: string): HumanReviewEvidenceStore {
  let operationChain: Promise<void> = Promise.resolve();

  function datasetPath(datasetType: HumanReviewDatasetType): string {
    return path.join(root, "datasets", DATASET_FILE_NAMES[datasetType]);
  }

  function matchesSample(sample: Record<string, unknown>, match: Record<string, unknown>): boolean {
    return Object.entries(match).every(([key, value]) => Object.is(sample[key], value));
  }

  async function readDatasetLines(filePath: string): Promise<string[]> {
    try {
      return (await fs.readFile(filePath, "utf-8"))
        .split("\n")
        .filter((line) => line.trim().length > 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  function shouldRetainLine(line: string, match: Record<string, unknown>): boolean {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return true;
      }
      return !matchesSample(parsed as Record<string, unknown>, match);
    } catch {
      return true;
    }
  }

  async function rewriteDatasetFile(filePath: string, lines: string[]): Promise<void> {
    if (lines.length === 0) {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      return;
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${String(process.pid)}.${String(Date.now())}.tmp`;
    await fs.writeFile(tempPath, `${lines.join("\n")}\n`, "utf-8");
    await fs.rename(tempPath, filePath);
  }

  async function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = operationChain.then(operation, operation);
    operationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  return {
    async appendDatasetSample(
      datasetType: HumanReviewDatasetType,
      sample: HumanReviewDatasetSample,
    ): Promise<string> {
      return await runExclusive(async () => {
        const filePath = datasetPath(datasetType);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.appendFile(filePath, `${JSON.stringify(sample)}\n`, "utf-8");
        return filePath;
      });
    },

    async upsertDatasetSample(
      datasetType: HumanReviewDatasetType,
      sample: HumanReviewDatasetSample,
      match: Record<string, unknown>,
    ): Promise<string> {
      return await runExclusive(async () => {
        const filePath = datasetPath(datasetType);
        const retainedLines = (await readDatasetLines(filePath)).filter((line) =>
          shouldRetainLine(line, match),
        );
        await rewriteDatasetFile(filePath, [...retainedLines, JSON.stringify(sample)]);
        return filePath;
      });
    },

    async deleteDatasetSamples(
      datasetType: HumanReviewDatasetType,
      match: Record<string, unknown>,
    ): Promise<string> {
      return await runExclusive(async () => {
        const filePath = datasetPath(datasetType);
        const retainedLines = (await readDatasetLines(filePath)).filter((line) =>
          shouldRetainLine(line, match),
        );
        await rewriteDatasetFile(filePath, retainedLines);
        return filePath;
      });
    },
  };
}

import fs from "node:fs/promises";
import path from "node:path";
import {
  createRuleViolationStatsStore,
  extractRuleViolationRunSnapshot,
  type RuleViolationRunSnapshot,
} from "../../api/ruleViolationStatsStore.js";

export type RuleViolationStatsRebuildSummary = {
  scannedResultFiles: number;
  rebuiltRuns: number;
  skippedFiles: number;
};

type CaseInfo = {
  case_id?: unknown;
  remote_task_id?: unknown;
  remote_test_case_id?: unknown;
  started_at?: unknown;
};

type ResultJson = {
  report_meta?: {
    unit_name?: unknown;
    generated_at?: unknown;
  };
  bound_rule_packs?: unknown;
  rule_audit_results?: unknown;
};

async function collectResultJsonPaths(rootDir: string): Promise<string[]> {
  const resultPaths: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (
        entry.isFile() &&
        entry.name === "result.json" &&
        path.basename(path.dirname(entryPath)) === "outputs"
      ) {
        resultPaths.push(entryPath);
      }
    }
  }

  await walk(rootDir);
  return resultPaths.sort((left, right) => left.localeCompare(right));
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function stableNumericId(value: string): number {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return 1_000_000_000 + (hash % 1_000_000_000);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseRemoteTaskId(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^remote-task-(\d+)$/.exec(value);
  if (!match) {
    return undefined;
  }
  return Number(match[1]);
}

function buildSnapshotFromResult(input: {
  localCaseRoot: string;
  resultPath: string;
  resultJson: ResultJson;
  caseInfo?: CaseInfo;
}): RuleViolationRunSnapshot | undefined {
  const caseDir = path.dirname(path.dirname(input.resultPath));
  const relativeCaseDir = path.relative(input.localCaseRoot, caseDir) || path.basename(caseDir);
  const unitName = readString(input.resultJson.report_meta?.unit_name);
  const caseInfoId = readString(input.caseInfo?.case_id);
  const caseId = unitName ?? caseInfoId ?? relativeCaseDir;
  const taskId =
    readNumber(input.caseInfo?.remote_task_id) ??
    parseRemoteTaskId(unitName) ??
    stableNumericId(relativeCaseDir);
  const isRemoteRun =
    readNumber(input.caseInfo?.remote_task_id) !== undefined ||
    parseRemoteTaskId(unitName) !== undefined;
  if (!isRemoteRun) {
    return undefined;
  }
  const testCaseId = readNumber(input.caseInfo?.remote_test_case_id) ?? taskId;
  const completedAt =
    readString(input.resultJson.report_meta?.generated_at) ??
    readString(input.caseInfo?.started_at) ??
    new Date().toISOString();

  return extractRuleViolationRunSnapshot({
    taskId,
    caseId,
    testCaseId,
    caseName: caseId,
    completedAt,
    boundRulePacks: Array.isArray(input.resultJson.bound_rule_packs)
      ? (input.resultJson.bound_rule_packs as Array<{ pack_id?: unknown; display_name?: unknown }>)
      : [],
    ruleAuditResults: Array.isArray(input.resultJson.rule_audit_results)
      ? (input.resultJson.rule_audit_results as never)
      : [],
  });
}

export async function rebuildRuleViolationStatsIndex(
  localCaseRoot: string,
): Promise<RuleViolationStatsRebuildSummary> {
  const resultPaths = await collectResultJsonPaths(localCaseRoot);
  const snapshots: RuleViolationRunSnapshot[] = [];
  let skippedFiles = 0;

  for (const resultPath of resultPaths) {
    try {
      const resultJson = await readJsonFile<ResultJson>(resultPath);
      if (!resultJson) {
        skippedFiles += 1;
        continue;
      }
      const caseDir = path.dirname(path.dirname(resultPath));
      const caseInfo = await readJsonFile<CaseInfo>(path.join(caseDir, "inputs", "case-info.json"));
      const snapshot = buildSnapshotFromResult({
        localCaseRoot,
        resultPath,
        resultJson,
        caseInfo,
      });
      if (snapshot) {
        snapshots.push(snapshot);
      }
    } catch (error) {
      skippedFiles += 1;
      console.warn(
        `rule_violation_stats_rebuild_skip resultPath=${resultPath} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  await createRuleViolationStatsStore(localCaseRoot).replaceRuns(snapshots);

  return {
    scannedResultFiles: resultPaths.length,
    rebuiltRuns: snapshots.length,
    skippedFiles,
  };
}

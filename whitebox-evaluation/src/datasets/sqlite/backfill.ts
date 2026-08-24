import fs from "node:fs/promises";
import path from "node:path";
import type { ConsistencyTaskRecord } from "../../api/consistencyTaskStore.js";
import type { RemoteTaskRecord } from "../../api/remoteTaskRegistry.js";
import type { RuleViolationRunSnapshot } from "../../api/ruleViolationStatsStore.js";
import type { ScoreDatabase } from "./database.js";
import {
  createSqliteConsistencyTaskStore,
  createSqliteRuleViolationStatsStore,
  updateSqliteRemoteTaskSummary,
} from "./stores.js";

async function readJsonFile(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function readArrayRecord(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "object" && value !== null) {
    const nested = (value as Record<string, unknown>)[key];
    return Array.isArray(nested) ? nested : [];
  }
  return [];
}

function isRemoteTaskRecord(value: unknown): value is RemoteTaskRecord {
  const record = value as Partial<RemoteTaskRecord>;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof record.taskId === "number" &&
    typeof record.status === "string" &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number"
  );
}

function isRuleRunSnapshot(value: unknown): value is RuleViolationRunSnapshot {
  const record = value as Partial<RuleViolationRunSnapshot>;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof record.taskId === "number" &&
    typeof record.caseId === "string" &&
    typeof record.testCaseId === "number" &&
    typeof record.caseName === "string" &&
    typeof record.completedAt === "string" &&
    Array.isArray(record.boundRulePacks) &&
    Array.isArray(record.rules)
  );
}

function isConsistencyRecord(value: unknown): value is ConsistencyTaskRecord {
  const record = value as Partial<ConsistencyTaskRecord>;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof record.id === "string" &&
    record.id.trim().length > 0 &&
    typeof record.sequence === "number" &&
    Number.isFinite(record.sequence)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readResultSummary(resultJson: Record<string, unknown>): {
  caseName?: string;
  taskType?: string;
  score: number | null;
  hardGateTriggered: boolean | null;
  risks: Array<{ level?: string; title?: string }>;
} {
  const basicInfo = asRecord(resultJson.basic_info);
  const overall = asRecord(resultJson.overall_conclusion);
  const caseName = basicInfo?.case_name ?? basicInfo?.name;
  const taskType = basicInfo?.task_type;
  const score = overall?.total_score;
  const hardGate = overall?.hard_gate_triggered;
  const risks = Array.isArray(resultJson.risks)
    ? resultJson.risks.flatMap((risk) => {
        const record = asRecord(risk);
        if (!record) {
          return [];
        }
        return [
          {
            level: typeof record.level === "string" ? record.level : undefined,
            title: typeof record.title === "string" ? record.title : undefined,
          },
        ];
      })
    : [];
  return {
    caseName: typeof caseName === "string" && caseName.trim().length > 0 ? caseName : undefined,
    taskType: typeof taskType === "string" && taskType.trim().length > 0 ? taskType : undefined,
    score: typeof score === "number" && Number.isFinite(score) ? score : null,
    hardGateTriggered: typeof hardGate === "boolean" ? hardGate : null,
    risks,
  };
}

export async function backfillSqliteIndexes(input: {
  localCaseRoot: string;
  db: ScoreDatabase;
}): Promise<void> {
  const ruleStore = createSqliteRuleViolationStatsStore(input.db);
  const consistencyStore = createSqliteConsistencyTaskStore(input.db);

  const remoteTaskIndex = await readJsonFile(
    path.join(input.localCaseRoot, "remote-task-index.json"),
  );
  for (const item of readArrayRecord(remoteTaskIndex, "records").filter(isRemoteTaskRecord)) {
    input.db.run(
      `INSERT INTO remote_task (
        task_id, status, created_at_ms, updated_at_ms, case_dir, token, test_case_id,
        test_case_name, test_case_type, error, remote_task_file, recovery_attempt_count,
        last_recovery_at_ms, result_available
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO NOTHING`,
      [
        item.taskId,
        item.status,
        item.createdAt,
        item.updatedAt,
        item.caseDir ?? null,
        item.token ?? null,
        item.testCaseId ?? null,
        item.testCaseName ?? null,
        item.testCaseType ?? null,
        item.error ?? null,
        item.remoteTaskFile ?? null,
        item.recoveryAttemptCount ?? null,
        item.lastRecoveryAt ?? null,
        0,
      ],
    );
    if (item.caseDir) {
      const resultJson = await readJsonFile(path.join(item.caseDir, "outputs", "result.json"));
      const resultRecord = asRecord(resultJson);
      if (resultRecord) {
        updateSqliteRemoteTaskSummary(input.db, {
          taskId: item.taskId,
          ...readResultSummary(resultRecord),
          resultAvailable: true,
        });
      }
    }
  }

  const ruleStats = await readJsonFile(path.join(input.localCaseRoot, "rule-violation-stats.json"));
  const ruleRuns = readArrayRecord(ruleStats, "runs").filter(isRuleRunSnapshot);
  if (ruleRuns.length > 0 && (await ruleStore.listRuns()).length === 0) {
    await ruleStore.replaceRuns(ruleRuns);
  }

  const consistencyIndex = await readJsonFile(
    path.join(input.localCaseRoot, "consistency-task-index.json"),
  );
  const consistencyRecords = readArrayRecord(consistencyIndex, "records").filter(
    isConsistencyRecord,
  );
  if (consistencyRecords.length > 0 && (await consistencyStore.list()).length === 0) {
    await consistencyStore.replace(consistencyRecords);
  }
}

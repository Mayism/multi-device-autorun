import type {
  ConsistencyTaskRecord,
  ConsistencyTaskStore,
} from "../../api/consistencyTaskStore.js";
import type {
  RemoteTaskRecord,
  RemoteTaskRecordPatch,
  RemoteTaskRegistry,
} from "../../api/remoteTaskRegistry.js";
import {
  type RuleViolationStatsQuery,
  type RuleViolationStatsResponse,
  type RuleViolationRunSnapshot,
  type RuleViolationStatsStore,
  sanitizeRuleViolationRunSnapshot,
} from "../../api/ruleViolationStatsStore.js";
import type { DashboardStatusCategory, DashboardTaskSummary } from "../dashboard/dashboardTypes.js";
import type { ScoreDatabase } from "./database.js";

type DashboardTaskQuery = {
  status?: DashboardStatusCategory;
  taskType?: string;
  keyword?: string;
  scoreMin?: number;
  scoreMax?: number;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
  sortBy: "createdAt" | "updatedAt" | "score" | "taskId";
  sortOrder: "asc" | "desc";
};

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return Number(value) === 1;
}

function uniqueSortedStrings(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function uniqueSortedNumbers(values: Iterable<number>): number[] {
  return Array.from(new Set(values)).sort((left, right) => left - right);
}

function isConsistencyRecord(value: unknown): value is ConsistencyTaskRecord {
  const record = value as { id?: unknown; sequence?: unknown };
  return (
    typeof value === "object" &&
    value !== null &&
    typeof record.id === "string" &&
    record.id.trim().length > 0 &&
    typeof record.sequence === "number" &&
    Number.isFinite(record.sequence)
  );
}

function normalizeConsistencyTaskRuns(record: ConsistencyTaskRecord): ConsistencyTaskRecord {
  const runs = Array.isArray(record.runs)
    ? record.runs.map((run) => {
        if (typeof run !== "object" || run === null) {
          return run;
        }
        const normalizedRun = { ...run } as Record<string, unknown>;
        if (typeof normalizedRun.status === "string") {
          const status = normalizedRun.status;
          if (
            status !== "pending_submit" &&
            status !== "submitted" &&
            status !== "preparing" &&
            status !== "queued" &&
            status !== "running" &&
            status !== "completed" &&
            status !== "failed" &&
            status !== "timed_out" &&
            status !== "missing"
          ) {
            normalizedRun.status = "pending_submit";
          }
        }
        return normalizedRun;
      })
    : record.runs;

  const { analysis: _analysis, ruleReport: _ruleReport, riskReport: _riskReport, ...rest } = record;
  return {
    ...rest,
    runs,
  };
}

type RemoteTaskRow = {
  task_id: number;
  status: RemoteTaskRecord["status"];
  created_at_ms: number;
  updated_at_ms: number;
  case_dir: string | null;
  token: string | null;
  test_case_id: number | null;
  test_case_name: string | null;
  test_case_type: string | null;
  error: string | null;
  remote_task_file: string | null;
  recovery_attempt_count: number | null;
  last_recovery_at_ms: number | null;
};

function toRemoteTaskRecord(row: RemoteTaskRow): RemoteTaskRecord {
  return {
    taskId: row.task_id,
    status: row.status,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
    caseDir: row.case_dir ?? undefined,
    token: row.token ?? undefined,
    testCaseId: row.test_case_id ?? undefined,
    testCaseName: row.test_case_name ?? undefined,
    testCaseType: row.test_case_type ?? undefined,
    error: row.error ?? undefined,
    remoteTaskFile: row.remote_task_file ?? undefined,
    recoveryAttemptCount: row.recovery_attempt_count ?? undefined,
    lastRecoveryAt: row.last_recovery_at_ms ?? undefined,
  };
}

export function createSqliteRemoteTaskRegistry(db: ScoreDatabase): RemoteTaskRegistry {
  function getExisting(taskId: number): RemoteTaskRecord | undefined {
    const row = db.get<RemoteTaskRow>(
      `SELECT task_id, status, created_at_ms, updated_at_ms, case_dir, token, test_case_id,
              test_case_name, test_case_type, error, remote_task_file, recovery_attempt_count,
              last_recovery_at_ms
         FROM remote_task
        WHERE task_id = ?`,
      [taskId],
    );
    return row ? toRemoteTaskRecord(row) : undefined;
  }

  return {
    async get(taskId: number): Promise<RemoteTaskRecord | undefined> {
      return getExisting(taskId);
    },

    async list(): Promise<RemoteTaskRecord[]> {
      return db
        .all<RemoteTaskRow>(
          `SELECT task_id, status, created_at_ms, updated_at_ms, case_dir, token, test_case_id,
                  test_case_name, test_case_type, error, remote_task_file, recovery_attempt_count,
                  last_recovery_at_ms
             FROM remote_task
            ORDER BY task_id`,
        )
        .map(toRemoteTaskRecord);
    },

    async upsert(patch: RemoteTaskRecordPatch): Promise<RemoteTaskRecord> {
      const existing = getExisting(patch.taskId);
      const now = Date.now();
      const record: RemoteTaskRecord = {
        taskId: patch.taskId,
        status: patch.status,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        caseDir: patch.caseDir ?? existing?.caseDir,
        token: patch.token ?? existing?.token,
        testCaseId: patch.testCaseId ?? existing?.testCaseId,
        testCaseName: patch.testCaseName ?? existing?.testCaseName,
        testCaseType: patch.testCaseType ?? existing?.testCaseType,
        error: patch.error ?? existing?.error,
        remoteTaskFile: patch.remoteTaskFile ?? existing?.remoteTaskFile,
        recoveryAttemptCount: patch.recoveryAttemptCount ?? existing?.recoveryAttemptCount,
        lastRecoveryAt: patch.lastRecoveryAt ?? existing?.lastRecoveryAt,
      };

      db.run(
        `INSERT INTO remote_task (
          task_id, status, created_at_ms, updated_at_ms, case_dir, token, test_case_id,
          test_case_name, test_case_type, error, remote_task_file, recovery_attempt_count,
          last_recovery_at_ms, result_available
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          status = excluded.status,
          updated_at_ms = excluded.updated_at_ms,
          case_dir = excluded.case_dir,
          token = excluded.token,
          test_case_id = excluded.test_case_id,
          test_case_name = excluded.test_case_name,
          test_case_type = excluded.test_case_type,
          error = excluded.error,
          remote_task_file = excluded.remote_task_file,
          recovery_attempt_count = excluded.recovery_attempt_count,
          last_recovery_at_ms = excluded.last_recovery_at_ms`,
        [
          record.taskId,
          record.status,
          record.createdAt,
          record.updatedAt,
          record.caseDir ?? null,
          record.token ?? null,
          record.testCaseId ?? null,
          record.testCaseName ?? null,
          record.testCaseType ?? null,
          record.error ?? null,
          record.remoteTaskFile ?? null,
          record.recoveryAttemptCount ?? null,
          record.lastRecoveryAt ?? null,
          0,
        ],
      );

      return record;
    },

    async delete(taskId: number): Promise<boolean> {
      const existing = getExisting(taskId);
      if (!existing) {
        return false;
      }
      db.transaction(() => {
        db.run("DELETE FROM rule_violation_run WHERE task_id = ?", [taskId]);
        db.run("DELETE FROM remote_task WHERE task_id = ?", [taskId]);
      });
      return true;
    },
  };
}

export function updateSqliteRemoteTaskSummary(
  db: ScoreDatabase,
  input: {
    taskId: number;
    caseName?: string;
    taskType?: string;
    score?: number | null;
    hardGateTriggered?: boolean | null;
    resultAvailable: boolean;
    resultError?: string;
    risks?: Array<{ level?: string; title?: string }>;
  },
): void {
  db.run(
    `UPDATE remote_task
        SET case_name = ?,
            task_type = ?,
            score = ?,
            hard_gate_triggered = ?,
            result_available = ?,
            result_error = ?,
            risks_json = ?
      WHERE task_id = ?`,
    [
      input.caseName ?? null,
      input.taskType ?? null,
      input.score ?? null,
      input.hardGateTriggered === null || input.hardGateTriggered === undefined
        ? null
        : input.hardGateTriggered
          ? 1
          : 0,
      input.resultAvailable ? 1 : 0,
      input.resultError ?? null,
      JSON.stringify(input.risks ?? []),
      input.taskId,
    ],
  );
}

type RemoteTaskSummaryRow = RemoteTaskRow & {
  case_name: string | null;
  task_type: string | null;
  score: number | null;
  hard_gate_triggered: number | null;
  result_available: number;
  result_error: string | null;
  risks_json: string | null;
};

function statusCategory(status: RemoteTaskRecord["status"]): DashboardStatusCategory {
  switch (status) {
    case "preparing":
      return "received";
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
    case "timed_out":
      return "failed";
  }
}

function toDashboardTaskSummary(row: RemoteTaskSummaryRow): DashboardTaskSummary {
  let risks: Array<{ level?: string; title?: string }> = [];
  try {
    const parsed = row.risks_json ? (JSON.parse(row.risks_json) as unknown) : [];
    risks = Array.isArray(parsed)
      ? parsed.flatMap((item) => {
          if (typeof item !== "object" || item === null) {
            return [];
          }
          return [
            {
              level: readString((item as Record<string, unknown>).level),
              title: readString((item as Record<string, unknown>).title),
            },
          ];
        })
      : [];
  } catch {
    risks = [];
  }
  return {
    taskId: row.task_id,
    testCaseId: row.test_case_id ?? undefined,
    name: row.case_name ?? row.test_case_name ?? `Task ${String(row.task_id)}`,
    status: row.status,
    statusCategory: statusCategory(row.status),
    taskType: row.task_type ?? row.test_case_type ?? "unknown",
    score: row.score,
    hardGateTriggered:
      row.hard_gate_triggered === null ? null : (readBoolean(row.hard_gate_triggered) ?? null),
    createdAt: new Date(row.created_at_ms).toISOString(),
    updatedAt: new Date(row.updated_at_ms).toISOString(),
    resultAvailable: row.result_available === 1,
    resultError: row.result_error ?? undefined,
    error: row.error ?? undefined,
    risks,
  };
}

const REMOTE_TASK_SUMMARY_COLUMNS = `task_id, status, created_at_ms, updated_at_ms, case_dir,
  token, test_case_id, test_case_name, test_case_type, error, remote_task_file,
  recovery_attempt_count, last_recovery_at_ms, case_name, task_type, score, hard_gate_triggered,
  result_available, result_error, risks_json`;

function appendDashboardTaskFilters(
  query: Partial<DashboardTaskQuery> & { from?: string; to?: string },
  params: Array<string | number>,
): string {
  const clauses: string[] = [];
  if (query.status) {
    const statusValues: RemoteTaskRecord["status"][] =
      query.status === "received"
        ? ["preparing"]
        : query.status === "failed"
          ? ["failed", "timed_out"]
          : [query.status];
    clauses.push(`status IN (${statusValues.map(() => "?").join(", ")})`);
    params.push(...statusValues);
  }
  if (query.taskType) {
    clauses.push("COALESCE(task_type, test_case_type, 'unknown') = ?");
    params.push(query.taskType);
  }
  if (query.from) {
    clauses.push("created_at_ms >= ?");
    params.push(Date.parse(query.from));
  }
  if (query.to) {
    clauses.push("created_at_ms <= ?");
    params.push(Date.parse(query.to));
  }
  if (query.scoreMin !== undefined) {
    clauses.push("score IS NOT NULL AND score >= ?");
    params.push(query.scoreMin);
  }
  if (query.scoreMax !== undefined) {
    clauses.push("score IS NOT NULL AND score <= ?");
    params.push(query.scoreMax);
  }
  const keyword = query.keyword?.trim().toLowerCase();
  if (keyword) {
    clauses.push(
      `(CAST(task_id AS TEXT) LIKE ? OR CAST(COALESCE(test_case_id, '') AS TEXT) LIKE ? OR LOWER(COALESCE(case_name, test_case_name, '')) LIKE ?)`,
    );
    const pattern = `%${keyword}%`;
    params.push(pattern, pattern, pattern);
  }
  return clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
}

function dashboardTaskOrderBy(query: DashboardTaskQuery): string {
  const direction = query.sortOrder === "asc" ? "ASC" : "DESC";
  switch (query.sortBy) {
    case "createdAt":
      return `created_at_ms ${direction}, task_id ${direction}`;
    case "updatedAt":
      return `updated_at_ms ${direction}, task_id ${direction}`;
    case "score":
      return `COALESCE(score, -9223372036854775808) ${direction}, task_id ${direction}`;
    case "taskId":
      return `task_id ${direction}`;
  }
}

export function listSqliteRemoteTaskSummaries(db: ScoreDatabase): DashboardTaskSummary[] {
  return db
    .all<RemoteTaskSummaryRow>(
      `SELECT ${REMOTE_TASK_SUMMARY_COLUMNS}
         FROM remote_task
        ORDER BY task_id`,
    )
    .map(toDashboardTaskSummary);
}

export function listSqliteRemoteTaskPage(
  db: ScoreDatabase,
  query: DashboardTaskQuery,
): { items: DashboardTaskSummary[]; total: number } {
  const params: Array<string | number> = [];
  const where = appendDashboardTaskFilters(query, params);
  const total =
    db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM remote_task${where}`, params)?.count ??
    0;
  const offset = (query.page - 1) * query.pageSize;
  const rows = db.all<RemoteTaskSummaryRow>(
    `SELECT ${REMOTE_TASK_SUMMARY_COLUMNS}
       FROM remote_task
      ${where}
      ORDER BY ${dashboardTaskOrderBy(query)}
      LIMIT ? OFFSET ?`,
    [...params, query.pageSize, offset],
  );
  return {
    total,
    items: rows.map(toDashboardTaskSummary),
  };
}

export function listSqliteRemoteTaskSummariesForRange(
  db: ScoreDatabase,
  query: { taskType?: string; from?: string; to?: string },
): DashboardTaskSummary[] {
  const params: Array<string | number> = [];
  const where = appendDashboardTaskFilters(query, params);
  return db
    .all<RemoteTaskSummaryRow>(
      `SELECT ${REMOTE_TASK_SUMMARY_COLUMNS}
         FROM remote_task
        ${where}
        ORDER BY task_id`,
      params,
    )
    .map(toDashboardTaskSummary);
}

export function countSqliteRemoteTaskStatuses(
  db: ScoreDatabase,
): Record<DashboardStatusCategory, number> {
  const counts: Record<DashboardStatusCategory, number> = {
    received: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
  };
  const rows = db.all<{ category: DashboardStatusCategory; count: number }>(
    `SELECT CASE status
              WHEN 'preparing' THEN 'received'
              WHEN 'queued' THEN 'queued'
              WHEN 'running' THEN 'running'
              WHEN 'completed' THEN 'completed'
              ELSE 'failed'
            END AS category,
            COUNT(*) AS count
       FROM remote_task
      GROUP BY category`,
  );
  for (const row of rows) {
    counts[row.category] = row.count;
  }
  return counts;
}

export function summarizeSqliteRemoteTasks(
  db: ScoreDatabase,
  query: { from?: string; to?: string },
): {
  statusCounts: Record<DashboardStatusCategory, number>;
  taskTypeCounts: Array<{ taskType: string; count: number }>;
  scoreSummary: {
    completedWithScore: number;
    averageScore: number | null;
    minScore: number | null;
    maxScore: number | null;
  };
} {
  const params: Array<string | number> = [];
  const where = appendDashboardTaskFilters(query, params);
  const statusCounts: Record<DashboardStatusCategory, number> = {
    received: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
  };
  for (const row of db.all<{ category: DashboardStatusCategory; count: number }>(
    `SELECT CASE status
              WHEN 'preparing' THEN 'received'
              WHEN 'queued' THEN 'queued'
              WHEN 'running' THEN 'running'
              WHEN 'completed' THEN 'completed'
              ELSE 'failed'
            END AS category,
            COUNT(*) AS count
       FROM remote_task
      ${where}
      GROUP BY category`,
    params,
  )) {
    statusCounts[row.category] = row.count;
  }
  const taskTypeCounts = db.all<{ taskType: string; count: number }>(
    `SELECT COALESCE(task_type, test_case_type, 'unknown') AS taskType, COUNT(*) AS count
       FROM remote_task
      ${where}
      GROUP BY taskType
      ORDER BY taskType`,
    params,
  );
  const scoreRow = db.get<{
    completedWithScore: number;
    averageScore: number | null;
    minScore: number | null;
    maxScore: number | null;
  }>(
    `SELECT COUNT(score) AS completedWithScore,
            ROUND(AVG(score), 2) AS averageScore,
            MIN(score) AS minScore,
            MAX(score) AS maxScore
       FROM remote_task
      ${where}${where ? " AND" : " WHERE"} status = 'completed' AND score IS NOT NULL`,
    params,
  );
  return {
    statusCounts,
    taskTypeCounts,
    scoreSummary: {
      completedWithScore: scoreRow?.completedWithScore ?? 0,
      averageScore: scoreRow?.averageScore ?? null,
      minScore: scoreRow?.minScore ?? null,
      maxScore: scoreRow?.maxScore ?? null,
    },
  };
}

type RuleStatsRow = {
  pack_id: string;
  rule_id: string;
  rule_summary: string;
  rule_source: RuleViolationRunSnapshot["rules"][number]["rule_source"];
  violation_count: number;
  affected_case_ids: string;
  affected_task_ids: string;
  last_violated_at_ms: number;
};

function appendRuleStatsFilters(
  query: RuleViolationStatsQuery,
  params: Array<string | number>,
  options: { includePackFilter: boolean } = { includePackFilter: true },
): string {
  const clauses: string[] = [];
  if (query.caseId !== undefined) {
    clauses.push("r.case_id = ?");
    params.push(query.caseId);
  }
  if (query.testCaseId !== undefined) {
    clauses.push("r.test_case_id = ?");
    params.push(query.testCaseId);
  }
  if (query.from !== undefined) {
    clauses.push("r.completed_at_ms >= ?");
    params.push(Date.parse(query.from));
  }
  if (query.to !== undefined) {
    clauses.push("r.completed_at_ms <= ?");
    params.push(Date.parse(query.to));
  }
  if (options.includePackFilter && query.packId !== undefined) {
    clauses.push("i.pack_id = ?");
    params.push(query.packId);
  }
  return clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
}

export function buildSqliteRuleViolationStatsResponse(
  db: ScoreDatabase,
  query: RuleViolationStatsQuery,
): RuleViolationStatsResponse {
  const params: Array<string | number> = [];
  const where = appendRuleStatsFilters(query, params);
  const runParams: Array<string | number> = [];
  const runWhere = appendRuleStatsFilters(query, runParams, { includePackFilter: false });
  const packRunFilter =
    query.packId === undefined
      ? ""
      : `${runWhere ? " AND" : " WHERE"} EXISTS (
          SELECT 1 FROM rule_violation_item pi
           WHERE pi.task_id = r.task_id AND pi.pack_id = ?
        )`;
  if (query.packId !== undefined) {
    runParams.push(query.packId);
  }
  const runSummary = db.get<{ totalRuns: number; caseCount: number }>(
    `SELECT COUNT(*) AS totalRuns,
            COUNT(DISTINCT r.case_id) AS caseCount
       FROM rule_violation_run r
      ${runWhere}${packRunFilter}`,
    runParams,
  );
  const eventSummary = db.get<{ totalViolationEvents: number }>(
    `SELECT COUNT(i.rule_id) AS totalViolationEvents
       FROM rule_violation_run r
       JOIN rule_violation_item i ON i.task_id = r.task_id
      ${where}`,
    params,
  );
  const rules = db
    .all<RuleStatsRow>(
      `SELECT i.pack_id,
              i.rule_id,
              i.rule_summary,
              i.rule_source,
              COUNT(*) AS violation_count,
              GROUP_CONCAT(DISTINCT r.case_id) AS affected_case_ids,
              GROUP_CONCAT(DISTINCT r.task_id) AS affected_task_ids,
              MAX(r.completed_at_ms) AS last_violated_at_ms
         FROM rule_violation_run r
         JOIN rule_violation_item i ON i.task_id = r.task_id
        ${where}
        GROUP BY i.pack_id, i.rule_id, i.rule_summary, i.rule_source
        ORDER BY violation_count DESC, i.pack_id ASC, i.rule_id ASC`,
      params,
    )
    .map((row) => {
      const affectedCaseIds = uniqueSortedStrings(row.affected_case_ids.split(","));
      const affectedTaskIds = uniqueSortedNumbers(
        row.affected_task_ids.split(",").map((taskId) => Number(taskId)),
      );
      return {
        pack_id: row.pack_id,
        rule_id: row.rule_id,
        rule_summary: row.rule_summary,
        rule_source: row.rule_source,
        violationCount: row.violation_count,
        affectedCaseCount: affectedCaseIds.length,
        affectedRunCount: affectedTaskIds.length,
        affectedCaseIds,
        affectedTaskIds,
        lastViolatedAt: toIso(row.last_violated_at_ms),
      };
    });

  return {
    success: true,
    filters: { ...query },
    summary: {
      totalRuns: runSummary?.totalRuns ?? 0,
      caseCount: runSummary?.caseCount ?? 0,
      violatedRuleCount: rules.length,
      totalViolationEvents: eventSummary?.totalViolationEvents ?? 0,
    },
    rules,
  };
}

type RuleRunRow = {
  task_id: number;
  case_id: string;
  test_case_id: number;
  case_name: string;
  completed_at_ms: number;
};

type RuleItemRow = {
  task_id: number;
  item_index: number;
  pack_id: string;
  rule_id: string;
  rule_summary: string;
  rule_source: RuleViolationRunSnapshot["rules"][number]["rule_source"];
  pack_display_name: string | null;
  conclusion: string;
};

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function createSqliteRuleViolationStatsStore(db: ScoreDatabase): RuleViolationStatsStore {
  function listItems(taskId: number): RuleItemRow[] {
    return db.all<RuleItemRow>(
      `SELECT task_id, item_index, pack_id, rule_id, rule_summary, rule_source, pack_display_name, conclusion
         FROM rule_violation_item
        WHERE task_id = ?
        ORDER BY item_index`,
      [taskId],
    );
  }

  function toSnapshot(row: RuleRunRow): RuleViolationRunSnapshot {
    const items = listItems(row.task_id);
    const packNames = new Map<string, string>();
    for (const item of items) {
      if (item.pack_display_name) {
        packNames.set(item.pack_id, item.pack_display_name);
      }
    }
    return {
      taskId: row.task_id,
      caseId: row.case_id,
      testCaseId: row.test_case_id,
      caseName: row.case_name,
      completedAt: toIso(row.completed_at_ms),
      boundRulePacks: Array.from(packNames.entries()).map(([pack_id, display_name]) => ({
        pack_id,
        display_name,
      })),
      rules: items.map((item) => ({
        pack_id: item.pack_id,
        rule_id: item.rule_id,
        rule_summary: item.rule_summary,
        rule_source: item.rule_source,
        result: "不满足",
        conclusion: item.conclusion,
      })),
    };
  }

  return {
    async listRuns(): Promise<RuleViolationRunSnapshot[]> {
      return db
        .all<RuleRunRow>(
          `SELECT task_id, case_id, test_case_id, case_name, completed_at_ms
             FROM rule_violation_run
            ORDER BY task_id`,
        )
        .map(toSnapshot);
    },

    async upsertRun(snapshot: RuleViolationRunSnapshot): Promise<RuleViolationRunSnapshot> {
      const sanitizedSnapshot = sanitizeRuleViolationRunSnapshot(snapshot);
      db.transaction(() => {
        db.run(
          `INSERT INTO rule_violation_run (task_id, case_id, test_case_id, case_name, completed_at_ms)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET
             case_id = excluded.case_id,
             test_case_id = excluded.test_case_id,
             case_name = excluded.case_name,
             completed_at_ms = excluded.completed_at_ms`,
          [
            sanitizedSnapshot.taskId,
            sanitizedSnapshot.caseId,
            sanitizedSnapshot.testCaseId,
            sanitizedSnapshot.caseName,
            Date.parse(sanitizedSnapshot.completedAt),
          ],
        );
        db.run("DELETE FROM rule_violation_item WHERE task_id = ?", [sanitizedSnapshot.taskId]);
        const packNames = new Map(
          sanitizedSnapshot.boundRulePacks.map((pack) => [pack.pack_id, pack.display_name]),
        );
        const violatedRules = sanitizedSnapshot.rules.filter((rule) => rule.result === "不满足");
        for (const [itemIndex, rule] of violatedRules.entries()) {
          db.run(
            `INSERT INTO rule_violation_item (
              task_id, item_index, pack_id, rule_id, rule_summary, rule_source, pack_display_name, conclusion
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              sanitizedSnapshot.taskId,
              itemIndex,
              rule.pack_id,
              rule.rule_id,
              rule.rule_summary,
              rule.rule_source,
              packNames.get(rule.pack_id) ?? null,
              rule.conclusion,
            ],
          );
        }
      });
      const row = db.get<RuleRunRow>(
        `SELECT task_id, case_id, test_case_id, case_name, completed_at_ms
           FROM rule_violation_run
          WHERE task_id = ?`,
        [sanitizedSnapshot.taskId],
      );
      if (!row) {
        throw new Error(
          `Rule violation run was not persisted: ${String(sanitizedSnapshot.taskId)}`,
        );
      }
      return toSnapshot(row);
    },

    async replaceRuns(snapshots: RuleViolationRunSnapshot[]): Promise<RuleViolationRunSnapshot[]> {
      db.transaction(() => {
        db.run("DELETE FROM rule_violation_item");
        db.run("DELETE FROM rule_violation_run");
        for (const snapshot of snapshots) {
          const sanitizedSnapshot = sanitizeRuleViolationRunSnapshot(snapshot);
          db.run(
            `INSERT INTO rule_violation_run (task_id, case_id, test_case_id, case_name, completed_at_ms)
             VALUES (?, ?, ?, ?, ?)`,
            [
              sanitizedSnapshot.taskId,
              sanitizedSnapshot.caseId,
              sanitizedSnapshot.testCaseId,
              sanitizedSnapshot.caseName,
              Date.parse(sanitizedSnapshot.completedAt),
            ],
          );
          const packNames = new Map(
            sanitizedSnapshot.boundRulePacks.map((pack) => [pack.pack_id, pack.display_name]),
          );
          const violatedRules = sanitizedSnapshot.rules.filter((rule) => rule.result === "不满足");
          for (const [itemIndex, rule] of violatedRules.entries()) {
            db.run(
              `INSERT INTO rule_violation_item (
                task_id, item_index, pack_id, rule_id, rule_summary, rule_source, pack_display_name, conclusion
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                sanitizedSnapshot.taskId,
                itemIndex,
                rule.pack_id,
                rule.rule_id,
                rule.rule_summary,
                rule.rule_source,
                packNames.get(rule.pack_id) ?? null,
                rule.conclusion,
              ],
            );
          }
        }
      });
      return await this.listRuns();
    },
  };
}

type ConsistencyTaskRow = {
  id: string;
  sequence: number;
  payload_json: string;
};

function toConsistencyRecord(row: ConsistencyTaskRow): ConsistencyTaskRecord {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  return {
    id: row.id,
    sequence: row.sequence,
    ...payload,
  };
}

export function createSqliteConsistencyTaskStore(db: ScoreDatabase): ConsistencyTaskStore {
  return {
    async list(): Promise<ConsistencyTaskRecord[]> {
      return db
        .all<ConsistencyTaskRow>(
          "SELECT id, sequence, payload_json FROM consistency_task ORDER BY sequence, id",
        )
        .map(toConsistencyRecord);
    },

    async replace(items: ConsistencyTaskRecord[]): Promise<ConsistencyTaskRecord[]> {
      db.transaction(() => {
        db.run("DELETE FROM consistency_task");
        for (const item of items.filter(isConsistencyRecord)) {
          const normalized = normalizeConsistencyTaskRuns({ ...item });
          const { id, sequence, ...payload } = normalized;
          db.run(
            `INSERT INTO consistency_task (id, sequence, payload_json, updated_at_ms)
             VALUES (?, ?, ?, ?)`,
            [id, sequence, JSON.stringify(payload), Date.now()],
          );
        }
      });
      return await this.list();
    },

    async upsert(item: ConsistencyTaskRecord): Promise<ConsistencyTaskRecord> {
      if (!isConsistencyRecord(item)) {
        throw new Error("Invalid consistency task record");
      }
      const existing = db.get<ConsistencyTaskRow>(
        "SELECT id, sequence, payload_json FROM consistency_task WHERE id = ?",
        [item.id],
      );
      const merged = normalizeConsistencyTaskRuns({
        ...(existing ? toConsistencyRecord(existing) : {}),
        ...item,
      });
      const { id, sequence, ...payload } = merged;
      db.run(
        `INSERT INTO consistency_task (id, sequence, payload_json, updated_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           sequence = excluded.sequence,
           payload_json = excluded.payload_json,
           updated_at_ms = excluded.updated_at_ms`,
        [id, sequence, JSON.stringify(payload), Date.now()],
      );
      return { ...merged };
    },

    async delete(id: string): Promise<boolean> {
      const existing = db.get<ConsistencyTaskRow>(
        "SELECT id, sequence, payload_json FROM consistency_task WHERE id = ?",
        [id],
      );
      if (!existing) {
        return false;
      }
      db.run("DELETE FROM consistency_task WHERE id = ?", [id]);
      return true;
    },
  };
}

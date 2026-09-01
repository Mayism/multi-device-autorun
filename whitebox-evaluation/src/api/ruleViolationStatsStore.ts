import fs from "node:fs/promises";
import path from "node:path";
import { getRegisteredRulePacks } from "../rules/registry/rulePackRegistry.js";
import type { RuleAuditResult } from "../types.js";

export type RuleViolationBoundRulePack = {
  pack_id: string;
  display_name: string;
};

export type RuleViolationRuleResult = {
  pack_id: string;
  rule_id: string;
  rule_summary: string;
  rule_source: "must_rule" | "should_rule" | "forbidden_pattern";
  result: "满足" | "不满足" | "不涉及" | "待人工复核";
  conclusion: string;
};

export type RuleViolationRunSnapshot = {
  taskId: number;
  caseId: string;
  testCaseId: number;
  caseName: string;
  completedAt: string;
  boundRulePacks: RuleViolationBoundRulePack[];
  rules: RuleViolationRuleResult[];
};

export type RuleViolationStatsQuery = {
  caseId?: string;
  testCaseId?: number;
  packId?: string;
  from?: string;
  to?: string;
};

export type RuleViolationStatsResponse = {
  success: true;
  filters: RuleViolationStatsQuery;
  summary: {
    totalRuns: number;
    caseCount: number;
    violatedRuleCount: number;
    totalViolationEvents: number;
  };
  rules: Array<{
    pack_id: string;
    rule_id: string;
    rule_summary: string;
    rule_source: "must_rule" | "should_rule" | "forbidden_pattern";
    violationCount: number;
    affectedCaseCount: number;
    affectedRunCount: number;
    affectedCaseIds: string[];
    affectedTaskIds: number[];
    lastViolatedAt: string;
  }>;
};

export type RuleViolationStatsStore = {
  listRuns(): Promise<RuleViolationRunSnapshot[]>;
  upsertRun(snapshot: RuleViolationRunSnapshot): Promise<RuleViolationRunSnapshot>;
  replaceRuns(snapshots: RuleViolationRunSnapshot[]): Promise<RuleViolationRunSnapshot[]>;
};

type StoredRuleViolationStats = {
  schemaVersion: 1;
  runs: RuleViolationRunSnapshot[];
};

type ExtractRuleViolationRunSnapshotInput = {
  taskId: number;
  caseId: string;
  testCaseId: number;
  caseName: string;
  completedAt?: string;
  boundRulePacks?: Array<{ pack_id?: unknown; display_name?: unknown }>;
  ruleAuditResults?: RuleAuditResult[];
};

const STATS_SCHEMA_VERSION = 1;

function getStaticRuleMetadata() {
  const packById = new Map<string, RuleViolationBoundRulePack>();
  const ruleById = new Map<
    string,
    {
      pack_id: string;
      rule_summary: string;
      rule_source: "must_rule" | "should_rule" | "forbidden_pattern";
    }
  >();

  for (const pack of getRegisteredRulePacks()) {
    packById.set(pack.packId, {
      pack_id: pack.packId,
      display_name: pack.displayName,
    });
    for (const rule of pack.rules) {
      ruleById.set(rule.rule_id, {
        pack_id: pack.packId,
        rule_summary: rule.summary,
        rule_source: rule.rule_source,
      });
    }
  }

  return { packById, ruleById };
}

function isRunSnapshot(value: unknown): value is RuleViolationRunSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<RuleViolationRunSnapshot>;
  return (
    typeof record.taskId === "number" &&
    typeof record.caseId === "string" &&
    typeof record.testCaseId === "number" &&
    typeof record.caseName === "string" &&
    typeof record.completedAt === "string" &&
    Array.isArray(record.boundRulePacks) &&
    Array.isArray(record.rules)
  );
}

function parseStoredStats(value: unknown): StoredRuleViolationStats {
  if (typeof value !== "object" || value === null) {
    return { schemaVersion: STATS_SCHEMA_VERSION, runs: [] };
  }
  const stored = value as { schemaVersion?: unknown; runs?: unknown };
  if (stored.schemaVersion !== STATS_SCHEMA_VERSION || !Array.isArray(stored.runs)) {
    return { schemaVersion: STATS_SCHEMA_VERSION, runs: [] };
  }
  return {
    schemaVersion: STATS_SCHEMA_VERSION,
    runs: stored.runs.filter(isRunSnapshot),
  };
}

function uniqueSortedStrings(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function uniqueSortedNumbers(values: Iterable<number>): number[] {
  return Array.from(new Set(values)).sort((left, right) => left - right);
}

function isIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp);
}

function isStaticPackId(packId: string): boolean {
  return getStaticRuleMetadata().packById.has(packId);
}

function runMatchesQuery(run: RuleViolationRunSnapshot, query: RuleViolationStatsQuery): boolean {
  if (query.caseId !== undefined && run.caseId !== query.caseId) {
    return false;
  }
  if (query.testCaseId !== undefined && run.testCaseId !== query.testCaseId) {
    return false;
  }
  if (query.from !== undefined && Date.parse(run.completedAt) < Date.parse(query.from)) {
    return false;
  }
  if (query.to !== undefined && Date.parse(run.completedAt) > Date.parse(query.to)) {
    return false;
  }
  if (query.packId !== undefined) {
    if (!isStaticPackId(query.packId)) {
      return false;
    }
    return run.boundRulePacks.some((pack) => pack.pack_id === query.packId);
  }
  return true;
}

function makeRuleKey(packId: string, ruleId: string): string {
  return `${packId}\u0000${ruleId}`;
}

export function sanitizeRuleViolationRunSnapshot(
  snapshot: RuleViolationRunSnapshot,
): RuleViolationRunSnapshot {
  const metadata = getStaticRuleMetadata();
  const rules = snapshot.rules
    .filter((rule) => rule.result === "不满足")
    .map((rule): RuleViolationRuleResult | undefined => {
      const staticRule = metadata.ruleById.get(rule.rule_id);
      if (!staticRule) {
        return undefined;
      }
      return {
        pack_id: staticRule.pack_id,
        rule_id: rule.rule_id,
        rule_summary: rule.rule_summary || staticRule.rule_summary,
        rule_source: staticRule.rule_source,
        result: "不满足",
        conclusion: rule.conclusion,
      };
    })
    .filter((rule): rule is RuleViolationRuleResult => Boolean(rule));
  const violatedPackIds = new Set(rules.map((rule) => rule.pack_id));
  const boundRulePacks = Array.from(violatedPackIds)
    .map((packId) => metadata.packById.get(packId))
    .filter((pack): pack is RuleViolationBoundRulePack => Boolean(pack))
    .sort((left, right) => left.pack_id.localeCompare(right.pack_id));

  return {
    ...snapshot,
    boundRulePacks,
    rules,
  };
}

export function extractRuleViolationRunSnapshot(
  input: ExtractRuleViolationRunSnapshotInput,
): RuleViolationRunSnapshot {
  const metadata = getStaticRuleMetadata();
  const rules = (input.ruleAuditResults ?? [])
    .map((rule): RuleViolationRuleResult | undefined => {
      const staticRule = metadata.ruleById.get(rule.rule_id);
      if (!staticRule || rule.result !== "不满足") {
        return undefined;
      }
      return {
        pack_id: staticRule.pack_id,
        rule_id: rule.rule_id,
        rule_summary: rule.rule_summary ?? staticRule.rule_summary,
        rule_source: staticRule.rule_source,
        result: rule.result,
        conclusion: rule.conclusion,
      };
    })
    .filter((rule): rule is RuleViolationRuleResult => Boolean(rule));
  const violatedPackIds = new Set(rules.map((rule) => rule.pack_id));
  const boundRulePacks = Array.from(violatedPackIds)
    .map((packId) => metadata.packById.get(packId))
    .filter((pack): pack is RuleViolationBoundRulePack => Boolean(pack))
    .sort((left, right) => left.pack_id.localeCompare(right.pack_id));

  return {
    taskId: input.taskId,
    caseId: input.caseId,
    testCaseId: input.testCaseId,
    caseName: input.caseName,
    completedAt: input.completedAt ?? new Date().toISOString(),
    boundRulePacks,
    rules,
  };
}

export function buildRuleViolationStatsResponse(
  runs: RuleViolationRunSnapshot[],
  query: RuleViolationStatsQuery,
): RuleViolationStatsResponse {
  const filteredRuns = runs.filter((run) => runMatchesQuery(run, query));
  const ruleStats = new Map<
    string,
    {
      pack_id: string;
      rule_id: string;
      rule_summary: string;
      rule_source: "must_rule" | "should_rule" | "forbidden_pattern";
      violationCount: number;
      affectedCaseIds: Set<string>;
      affectedTaskIds: Set<number>;
      lastViolatedAt: string;
    }
  >();

  for (const run of filteredRuns) {
    for (const rule of run.rules) {
      if (rule.result !== "不满足") {
        continue;
      }
      if (query.packId !== undefined && rule.pack_id !== query.packId) {
        continue;
      }
      const key = makeRuleKey(rule.pack_id, rule.rule_id);
      const existing = ruleStats.get(key);
      if (!existing) {
        ruleStats.set(key, {
          pack_id: rule.pack_id,
          rule_id: rule.rule_id,
          rule_summary: rule.rule_summary,
          rule_source: rule.rule_source,
          violationCount: 1,
          affectedCaseIds: new Set([run.caseId]),
          affectedTaskIds: new Set([run.taskId]),
          lastViolatedAt: run.completedAt,
        });
        continue;
      }
      existing.violationCount += 1;
      existing.affectedCaseIds.add(run.caseId);
      existing.affectedTaskIds.add(run.taskId);
      if (Date.parse(run.completedAt) > Date.parse(existing.lastViolatedAt)) {
        existing.lastViolatedAt = run.completedAt;
      }
    }
  }

  const rules = Array.from(ruleStats.values())
    .map((rule) => {
      const affectedCaseIds = uniqueSortedStrings(rule.affectedCaseIds);
      const affectedTaskIds = uniqueSortedNumbers(rule.affectedTaskIds);
      return {
        pack_id: rule.pack_id,
        rule_id: rule.rule_id,
        rule_summary: rule.rule_summary,
        rule_source: rule.rule_source,
        violationCount: rule.violationCount,
        affectedCaseCount: affectedCaseIds.length,
        affectedRunCount: affectedTaskIds.length,
        affectedCaseIds,
        affectedTaskIds,
        lastViolatedAt: rule.lastViolatedAt,
      };
    })
    .sort(
      (left, right) =>
        right.violationCount - left.violationCount ||
        left.pack_id.localeCompare(right.pack_id) ||
        left.rule_id.localeCompare(right.rule_id),
    );

  return {
    success: true,
    filters: { ...query },
    summary: {
      totalRuns: filteredRuns.length,
      caseCount: new Set(filteredRuns.map((run) => run.caseId)).size,
      violatedRuleCount: rules.length,
      totalViolationEvents: rules.reduce((sum, rule) => sum + rule.violationCount, 0),
    },
    rules,
  };
}

export function validateRuleViolationStatsQuery(
  query: RuleViolationStatsQuery,
): string | undefined {
  if (query.from !== undefined && !isIsoTimestamp(query.from)) {
    return "Invalid query parameter: from must be an ISO timestamp";
  }
  if (query.to !== undefined && !isIsoTimestamp(query.to)) {
    return "Invalid query parameter: to must be an ISO timestamp";
  }
  return undefined;
}

export function createRuleViolationStatsStore(localCaseRoot: string): RuleViolationStatsStore {
  const indexPath = path.join(localCaseRoot, "rule-violation-stats.json");
  const runs = new Map<number, RuleViolationRunSnapshot>();
  let loaded = false;
  let operationChain: Promise<void> = Promise.resolve();

  async function load(): Promise<void> {
    if (loaded) {
      return;
    }
    loaded = true;
    try {
      const text = await fs.readFile(indexPath, "utf-8");
      const stored = parseStoredStats(JSON.parse(text) as unknown);
      for (const run of stored.runs) {
        runs.set(run.taskId, sanitizeRuleViolationRunSnapshot(run));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  async function save(): Promise<void> {
    await fs.mkdir(localCaseRoot, { recursive: true });
    const tempPath = `${indexPath}.${String(process.pid)}.tmp`;
    const content = JSON.stringify(
      {
        schemaVersion: STATS_SCHEMA_VERSION,
        runs: Array.from(runs.values()).sort((left, right) => left.taskId - right.taskId),
      },
      null,
      2,
    );
    await fs.writeFile(tempPath, content, "utf-8");
    await fs.rename(tempPath, indexPath);
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
    async listRuns(): Promise<RuleViolationRunSnapshot[]> {
      return await runExclusive(async () => {
        await load();
        return Array.from(runs.values()).sort((left, right) => left.taskId - right.taskId);
      });
    },

    async upsertRun(snapshot: RuleViolationRunSnapshot): Promise<RuleViolationRunSnapshot> {
      return await runExclusive(async () => {
        await load();
        const sanitizedSnapshot = sanitizeRuleViolationRunSnapshot(snapshot);
        runs.set(sanitizedSnapshot.taskId, sanitizedSnapshot);
        await save();
        return sanitizedSnapshot;
      });
    },

    async replaceRuns(snapshots: RuleViolationRunSnapshot[]): Promise<RuleViolationRunSnapshot[]> {
      return await runExclusive(async () => {
        await load();
        runs.clear();
        for (const snapshot of snapshots) {
          const sanitizedSnapshot = sanitizeRuleViolationRunSnapshot(snapshot);
          runs.set(sanitizedSnapshot.taskId, sanitizedSnapshot);
        }
        await save();
        return Array.from(runs.values()).sort((left, right) => left.taskId - right.taskId);
      });
    },
  };
}

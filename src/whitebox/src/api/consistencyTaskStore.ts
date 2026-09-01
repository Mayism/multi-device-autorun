import fs from "node:fs/promises";
import path from "node:path";

export type ConsistencyTaskRecord = {
  id: string;
  sequence: number;
  [key: string]: unknown;
};

export type ConsistencyTaskStore = {
  list(): Promise<ConsistencyTaskRecord[]>;
  replace(items: ConsistencyTaskRecord[]): Promise<ConsistencyTaskRecord[]>;
  upsert(item: ConsistencyTaskRecord): Promise<ConsistencyTaskRecord>;
  delete(id: string): Promise<boolean>;
};

function isRecord(value: unknown): value is ConsistencyTaskRecord {
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

function normalizeTaskRuns(record: ConsistencyTaskRecord): ConsistencyTaskRecord {
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

export function createConsistencyTaskStore(localCaseRoot: string): ConsistencyTaskStore {
  const indexPath = path.join(localCaseRoot, "consistency-task-index.json");
  let loaded = false;
  let records: ConsistencyTaskRecord[] = [];
  let operationChain: Promise<void> = Promise.resolve();

  async function load(): Promise<void> {
    if (loaded) {
      return;
    }
    loaded = true;
    try {
      const text = await fs.readFile(indexPath, "utf-8");
      const parsed = JSON.parse(text) as unknown;
      const items = Array.isArray(parsed)
        ? parsed
        : typeof parsed === "object" &&
            parsed !== null &&
            Array.isArray((parsed as { records?: unknown }).records)
          ? (parsed as { records: unknown[] }).records
          : [];
      records = items.filter(isRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  async function save(): Promise<void> {
    await fs.mkdir(localCaseRoot, { recursive: true });
    const tempPath = `${indexPath}.${String(process.pid)}.tmp`;
    const content = JSON.stringify({ records }, null, 2);
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
    async list(): Promise<ConsistencyTaskRecord[]> {
      return await runExclusive(async () => {
        await load();
        return records.map((item) => ({ ...item }));
      });
    },

    async replace(items: ConsistencyTaskRecord[]): Promise<ConsistencyTaskRecord[]> {
      return await runExclusive(async () => {
        await load();
        records = items.filter(isRecord).map((item) => normalizeTaskRuns({ ...item }));
        await save();
        return records.map((item) => ({ ...item }));
      });
    },

    async upsert(item: ConsistencyTaskRecord): Promise<ConsistencyTaskRecord> {
      return await runExclusive(async () => {
        await load();
        const existingIndex = records.findIndex((record) => record.id === item.id);
        const merged = normalizeTaskRuns({
          ...(existingIndex >= 0 ? records[existingIndex] : {}),
          ...item,
        });
        if (existingIndex >= 0) {
          records[existingIndex] = merged;
        } else {
          records.push(merged);
        }
        await save();
        return { ...merged };
      });
    },

    async delete(id: string): Promise<boolean> {
      return await runExclusive(async () => {
        await load();
        const beforeLength = records.length;
        records = records.filter((record) => record.id !== id);
        if (records.length === beforeLength) {
          return false;
        }
        await save();
        return true;
      });
    },
  };
}

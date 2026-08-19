import fs from "node:fs/promises";
import path from "node:path";

export type RemoteTaskRecordStatus =
  | "preparing"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timed_out";

export type RemoteTaskRecord = {
  taskId: number;
  status: RemoteTaskRecordStatus;
  createdAt: number;
  updatedAt: number;
  caseDir?: string;
  token?: string;
  testCaseId?: number;
  testCaseName?: string;
  testCaseType?: string;
  error?: string;
  remoteTaskFile?: string;
  recoveryAttemptCount?: number;
  lastRecoveryAt?: number;
};

export type RemoteTaskRecordPatch = {
  taskId: number;
  status: RemoteTaskRecordStatus;
  caseDir?: string;
  token?: string;
  testCaseId?: number;
  testCaseName?: string;
  testCaseType?: string;
  error?: string;
  remoteTaskFile?: string;
  recoveryAttemptCount?: number;
  lastRecoveryAt?: number;
};

export type RemoteTaskRegistry = {
  get(taskId: number): Promise<RemoteTaskRecord | undefined>;
  list(): Promise<RemoteTaskRecord[]>;
  upsert(patch: RemoteTaskRecordPatch): Promise<RemoteTaskRecord>;
  delete(taskId: number): Promise<boolean>;
};

function isRecord(value: unknown): value is RemoteTaskRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { taskId?: unknown }).taskId === "number" &&
    typeof (value as { status?: unknown }).status === "string" &&
    typeof (value as { createdAt?: unknown }).createdAt === "number" &&
    typeof (value as { updatedAt?: unknown }).updatedAt === "number"
  );
}

export function createRemoteTaskRegistry(localCaseRoot: string): RemoteTaskRegistry {
  const indexPath = path.join(localCaseRoot, "remote-task-index.json");
  const records = new Map<number, RemoteTaskRecord>();
  let loaded = false;
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
      for (const item of items) {
        if (isRecord(item)) {
          records.set(item.taskId, item);
        }
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
      { records: [...records.values()].sort((left, right) => left.taskId - right.taskId) },
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
    async get(taskId: number): Promise<RemoteTaskRecord | undefined> {
      return await runExclusive(async () => {
        await load();
        return records.get(taskId);
      });
    },

    async list(): Promise<RemoteTaskRecord[]> {
      return await runExclusive(async () => {
        await load();
        return Array.from(records.values()).sort((left, right) => left.taskId - right.taskId);
      });
    },

    async upsert(patch: RemoteTaskRecordPatch): Promise<RemoteTaskRecord> {
      return await runExclusive(async () => {
        await load();
        const existing = records.get(patch.taskId);
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
        records.set(record.taskId, record);
        await save();
        return record;
      });
    },

    async delete(taskId: number): Promise<boolean> {
      return await runExclusive(async () => {
        await load();
        const deleted = records.delete(taskId);
        if (deleted) {
          await save();
        }
        return deleted;
      });
    },
  };
}

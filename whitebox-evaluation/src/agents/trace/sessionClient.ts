import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpencodeSessionSnapshot } from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function normalizeMessage(value: unknown): { info?: Record<string, unknown>; parts?: unknown[] } {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  const info = asRecord(record.info) ?? asRecord(record.properties)?.info;
  const parts = Array.isArray(record.parts) ? record.parts : [];
  return {
    info: asRecord(info),
    parts,
  };
}

function normalizeMessages(payload: unknown): Array<{ info?: Record<string, unknown>; parts?: unknown[] }> {
  if (Array.isArray(payload)) {
    return payload.map(normalizeMessage);
  }
  const record = asRecord(payload);
  if (!record) {
    return [];
  }
  if (Array.isArray(record.messages)) {
    return record.messages.map(normalizeMessage);
  }
  if (Array.isArray(record.data)) {
    return record.data.map(normalizeMessage);
  }
  if (record.info || record.parts) {
    return [normalizeMessage(record)];
  }
  return [];
}

type SqliteSessionRow = {
  id: string;
  title: string | null;
  directory: string | null;
  time_created: number | null;
  time_updated: number | null;
};

type SqliteMessageRow = {
  id: string;
  time_created: number;
  time_updated: number;
  data: string;
};

type SqlitePartRow = {
  id: string;
  message_id: string;
  time_created: number;
  time_updated: number;
  data: string;
};

function readOpencodeSqliteSnapshot(input: {
  runtimeDir?: string;
  sessionId: string;
}): OpencodeSessionSnapshot | undefined {
  if (!input.runtimeDir) {
    return undefined;
  }
  const dbPath = path.join(input.runtimeDir, "xdg-data", "opencode", "opencode.db");
  if (!fs.existsSync(dbPath)) {
    return undefined;
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const session = db
      .prepare(
        `SELECT id, title, directory, time_created, time_updated
           FROM session
          WHERE id = ?`,
      )
      .get(input.sessionId) as SqliteSessionRow | undefined;
    if (!session) {
      return undefined;
    }
    const messages = db
      .prepare(
        `SELECT id, time_created, time_updated, data
           FROM message
          WHERE session_id = ?
          ORDER BY time_created, id`,
      )
      .all(input.sessionId) as SqliteMessageRow[];
    const parts = db
      .prepare(
        `SELECT id, message_id, time_created, time_updated, data
           FROM part
          WHERE session_id = ?
          ORDER BY time_created, id`,
      )
      .all(input.sessionId) as SqlitePartRow[];
    const partsByMessageId = new Map<string, unknown[]>();
    for (const part of parts) {
      const data = parseJsonRecord(part.data) ?? {};
      const normalized = {
        id: part.id,
        created: part.time_created,
        updated: part.time_updated,
        ...data,
      };
      const items = partsByMessageId.get(part.message_id) ?? [];
      items.push(normalized);
      partsByMessageId.set(part.message_id, items);
    }
    return {
      id: input.sessionId,
      title: session.title ?? undefined,
      directory: session.directory ?? undefined,
      createdAtMs: session.time_created ?? undefined,
      updatedAtMs: session.time_updated ?? undefined,
      source: "sqlite",
      messages: messages.map((message) => {
        const info = parseJsonRecord(message.data) ?? {};
        return {
          info: {
            id: message.id,
            created: message.time_created,
            updated: message.time_updated,
            ...info,
          },
          parts: partsByMessageId.get(message.id) ?? [],
        };
      }),
    };
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

export async function fetchOpencodeSessionSnapshot(input: {
  serverUrl: string;
  runtimeDir?: string;
  sessionId: string;
}): Promise<OpencodeSessionSnapshot | undefined> {
  const sqliteSnapshot = readOpencodeSqliteSnapshot(input);
  if (sqliteSnapshot && sqliteSnapshot.messages.length > 0) {
    return sqliteSnapshot;
  }
  const response = await fetch(
    `${input.serverUrl.replace(/\/$/, "")}/session/${encodeURIComponent(input.sessionId)}/message`,
  );
  if (!response.ok) {
    return undefined;
  }
  const payload = (await response.json()) as unknown;
  const record = asRecord(payload);
  const session = asRecord(record?.session) ?? asRecord(record?.info);
  return {
    id: input.sessionId,
    title: readString(session?.title),
    directory: readString(session?.directory) ?? readString(session?.cwd),
    createdAtMs: readNumber(session?.created) ?? readNumber(session?.createdAtMs),
    updatedAtMs: readNumber(session?.updated) ?? readNumber(session?.updatedAtMs),
    source: "api",
    messages: normalizeMessages(payload),
  };
}

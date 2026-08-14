import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface FoldServerState {
  schemaVersion: 1;
  pid: number;
  port: number;
  devicePort: number;
  target: string;
  ownerToken: string;
  forwardTask: string;
  createdAt: string;
}

export interface StoredFoldServerState {
  state: FoldServerState;
  stateFile: string;
}

export async function writeFoldServerState(
  state: FoldServerState,
  hdc: string,
  stateRoot: string = defaultFoldStateRoot(),
): Promise<string> {
  await fs.mkdir(stateRoot, { recursive: true });
  const stateFile = foldServerStateFile(hdc, state.target, stateRoot);
  const temporaryFile = `${stateFile}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(
    temporaryFile,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf-8",
  );
  await fs.rename(temporaryFile, stateFile);
  return stateFile;
}

export async function readFoldServerState(
  hdc: string,
  target: string,
  stateRoot: string = defaultFoldStateRoot(),
): Promise<StoredFoldServerState | undefined> {
  const stateFile = foldServerStateFile(hdc, target, stateRoot);
  let raw: string;
  try {
    raw = await fs.readFile(stateFile, "utf-8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  const state = parseFoldServerState(raw);
  if (state.target !== target) throw new Error("fold_state_invalid");
  return { state, stateFile };
}

export async function removeFoldServerState(stateFile: string): Promise<void> {
  await fs.rm(stateFile, { force: true });
}

export function foldServerStateFile(
  hdc: string,
  target: string,
  stateRoot: string = defaultFoldStateRoot(),
): string {
  const key = crypto
    .createHash("sha256")
    .update(`${hdc}\0${target}`)
    .digest("hex")
    .slice(0, 24);
  return path.join(stateRoot, `${key}.json`);
}

function defaultFoldStateRoot(): string {
  return path.join(os.tmpdir(), "harmonyos-ohostest-runner", "fold");
}

function parseFoldServerState(raw: string): FoldServerState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("fold_state_invalid");
  }
  if (!isFoldServerState(value)) throw new Error("fold_state_invalid");
  return value;
}

function isFoldServerState(value: unknown): value is FoldServerState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<FoldServerState>;
  return (
    state.schemaVersion === 1 &&
    Number.isSafeInteger(state.pid) &&
    state.pid! > 0 &&
    Number.isSafeInteger(state.port) &&
    state.port! > 1 &&
    state.port! <= 65535 &&
    Number.isSafeInteger(state.devicePort) &&
    state.devicePort === state.port! - 1 &&
    typeof state.target === "string" &&
    state.target.length > 0 &&
    typeof state.ownerToken === "string" &&
    state.ownerToken.length > 0 &&
    state.forwardTask === `tcp:${state.devicePort} tcp:${state.port}` &&
    typeof state.createdAt === "string"
  );
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

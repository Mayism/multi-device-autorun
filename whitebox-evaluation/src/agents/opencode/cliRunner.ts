import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { OpencodeRuntimeConfig } from "./config.js";

export interface OpencodeRunRequest {
  prompt: string;
  sandboxRoot: string;
  requestTag: string;
  title?: string;
  agent?: string;
  continueSessionId?: string;
  outputFile?: string;
  preserveOutputFileOnStart?: boolean;
  logger?: {
    info(message: string): Promise<void> | void;
  };
}

export interface OpencodeRunResult {
  requestTag: string;
  rawText: string;
  rawEvents: string;
  elapsedMs: number;
  sessionId?: string;
  tokenUsage?: OpencodeTokenUsage;
  assistantText?: string;
  outputFile?: string;
  outputFileText?: string;
}

export interface OpencodeTokenUsage {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export class OpencodeRunError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OpencodeRunError";
  }
}

type SpawnedProcess = Pick<ChildProcess, "stdout" | "stderr" | "on" | "kill">;

type RunnerDeps = {
  spawnProcess?: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] },
  ) => SpawnedProcess;
  setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout | undefined;
  clearTimer?: (timer: NodeJS.Timeout | undefined) => void;
};

type RunInput = {
  runtime: OpencodeRuntimeConfig;
  request: OpencodeRunRequest;
  deps?: RunnerDeps;
};

function defaultSpawnProcess(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] },
): SpawnedProcess {
  return spawn(command, args, options);
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "opencode";
}

function stderrSnippet(stderr: Buffer[]): string {
  return Buffer.concat(stderr).toString("utf-8").slice(0, 1000);
}

function stdoutTail(rawEvents: string): string {
  return rawEvents.trim().slice(-1000);
}

function readErrorDetail(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const data = record.data && typeof record.data === "object"
    ? (record.data as Record<string, unknown>)
    : record;
  const message = typeof data.message === "string" ? data.message.trim() : "";
  const statusCode = typeof data.statusCode === "number" ? String(data.statusCode) : "";
  const metadata = data.metadata && typeof data.metadata === "object"
    ? (data.metadata as Record<string, unknown>)
    : undefined;
  const url = typeof metadata?.url === "string" ? metadata.url : "";
  if (!message && !statusCode) {
    return undefined;
  }
  return [statusCode ? `status=${statusCode}` : "", message, url ? `url=${url}` : ""]
    .filter(Boolean)
    .join(" ");
}

function extractModelCallError(rawEvents: string): OpencodeRunError | undefined {
  for (const line of rawEvents.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as unknown;
      if (!event || typeof event !== "object") {
        continue;
      }
      const record = event as Record<string, unknown>;
      const candidates = [
        record.error,
        record.properties && typeof record.properties === "object"
          ? (record.properties as Record<string, unknown>).error
          : undefined,
        record.part && typeof record.part === "object"
          ? (record.part as Record<string, unknown>).error
          : undefined,
      ];
      for (const candidate of candidates) {
        const detail = readErrorDetail(candidate);
        if (detail) {
          return new OpencodeRunError(`opencode 模型调用失败 ${detail}`);
        }
      }
    } catch {
      // Ignore non-JSON diagnostic lines and keep scanning structured events.
    }
  }
  return undefined;
}

function summarizeEventTypes(rawEvents: string): string {
  const types: string[] = [];
  for (const line of rawEvents.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as unknown;
      if (!event || typeof event !== "object") {
        continue;
      }
      const type = (event as Record<string, unknown>).type;
      types.push(typeof type === "string" ? type : "unknown");
    } catch {
      types.push("unparseable");
    }
  }
  return types.slice(-20).join(",") || "none";
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeTokenUsage(tokens: unknown): OpencodeTokenUsage | undefined {
  if (!tokens || typeof tokens !== "object") {
    return undefined;
  }
  const record = tokens as Record<string, unknown>;
  const input = readFiniteNumber(record.input);
  const output = readFiniteNumber(record.output);
  const reasoning = readFiniteNumber(record.reasoning);
  const cache = record.cache && typeof record.cache === "object" ? (record.cache as Record<string, unknown>) : undefined;
  const cacheRead = readFiniteNumber(cache?.read);
  const cacheWrite = readFiniteNumber(cache?.write);
  const total =
    readFiniteNumber(record.total) ??
    (input !== undefined &&
    output !== undefined &&
    reasoning !== undefined &&
    cacheRead !== undefined &&
    cacheWrite !== undefined
      ? input + output + reasoning + cacheRead + cacheWrite
      : undefined);

  if (
    input === undefined ||
    output === undefined ||
    reasoning === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    total === undefined
  ) {
    return undefined;
  }

  return { total, input, output, reasoning, cacheRead, cacheWrite };
}

function extractTokenUsage(rawEvents: string): OpencodeTokenUsage | undefined {
  let latestTokenUsage: OpencodeTokenUsage | undefined;

  for (const line of rawEvents.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") {
      continue;
    }

    const record = event as Record<string, unknown>;
    const type = record.type;
    const part = record.part;
    if (part && typeof part === "object") {
      const partRecord = part as Record<string, unknown>;
      if (partRecord.type === "step-finish") {
        const tokenUsage = normalizeTokenUsage(partRecord.tokens);
        if (tokenUsage) {
          latestTokenUsage = tokenUsage;
        }
      }
    }

    if (typeof type === "string" && type.startsWith("message.updated")) {
      const properties = record.properties;
      if (properties && typeof properties === "object") {
        const info = (properties as Record<string, unknown>).info;
        if (info && typeof info === "object") {
          const infoRecord = info as Record<string, unknown>;
          if (infoRecord.role === "assistant") {
            const tokenUsage = normalizeTokenUsage(infoRecord.tokens);
            if (tokenUsage) {
              latestTokenUsage = tokenUsage;
            }
          }
        }
      }
    }
  }

  return latestTokenUsage;
}

function readSessionIdFromRecord(record: Record<string, unknown>): string | undefined {
  for (const key of ["sessionId", "sessionID", "session_id", "id"]) {
    const value = record[key];
    if (typeof value === "string" && /^ses_[A-Za-z0-9]+$/.test(value)) {
      return value;
    }
  }

  const session = record.session;
  if (session && typeof session === "object") {
    const sessionId = readSessionIdFromRecord(session as Record<string, unknown>);
    if (sessionId) {
      return sessionId;
    }
  }

  const info = record.info;
  if (info && typeof info === "object") {
    const sessionId = readSessionIdFromRecord(info as Record<string, unknown>);
    if (sessionId) {
      return sessionId;
    }
  }

  const properties = record.properties;
  if (properties && typeof properties === "object") {
    const sessionId = readSessionIdFromRecord(properties as Record<string, unknown>);
    if (sessionId) {
      return sessionId;
    }
  }

  return undefined;
}

function extractSessionId(rawEvents: string): string | undefined {
  for (const line of rawEvents.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as unknown;
      if (!event || typeof event !== "object") {
        continue;
      }
      const sessionId = readSessionIdFromRecord(event as Record<string, unknown>);
      if (sessionId) {
        return sessionId;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function extractAssistantText(rawEvents: string): string {
  const streamedTextParts: string[] = [];
  for (const line of rawEvents.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") {
      continue;
    }
    const record = event as Record<string, unknown>;
    const part = record.part;
    if (part && typeof part === "object") {
      const partRecord = part as Record<string, unknown>;
      if (partRecord.type === "text" && typeof partRecord.text === "string") {
        streamedTextParts.push(partRecord.text);
        continue;
      }
    }
  }
  const text = streamedTextParts.join("");
  if (!text.trim()) {
    throw new OpencodeRunError(
      `opencode 输出中缺少 assistant 最终文本 stdoutBytes=${Buffer.byteLength(rawEvents, "utf-8")} eventTypes=${summarizeEventTypes(rawEvents)} stdoutTail=${stdoutTail(rawEvents)}`,
    );
  }
  return text;
}

function formatTokenUsageLog(tokenUsage: OpencodeTokenUsage): string {
  return [
    `tokens=${String(tokenUsage.total)}`,
    `inputTokens=${String(tokenUsage.input)}`,
    `outputTokens=${String(tokenUsage.output)}`,
    `reasoningTokens=${String(tokenUsage.reasoning)}`,
    `cacheReadTokens=${String(tokenUsage.cacheRead)}`,
    `cacheWriteTokens=${String(tokenUsage.cacheWrite)}`,
  ].join(" ");
}

function resolveAgentOutputPath(sandboxRoot: string, outputFile: string): string {
  if (!/^metadata\/agent-output\/[a-z-]+\.json$/.test(outputFile)) {
    throw new OpencodeRunError(`invalid agent output file: ${outputFile}`);
  }

  const root = path.resolve(sandboxRoot);
  const resolved = path.resolve(root, outputFile);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new OpencodeRunError(`agent output file escapes sandbox: ${outputFile}`);
  }
  return resolved;
}

async function logInfo(request: OpencodeRunRequest, message: string): Promise<void> {
  try {
    await request.logger?.info(message);
  } catch {
    // Logging must not change scoring behavior.
  }
}

export async function runOpencodePrompt(input: RunInput): Promise<OpencodeRunResult> {
  const startedAt = Date.now();
  const spawnProcess = input.deps?.spawnProcess ?? defaultSpawnProcess;
  const setTimer = input.deps?.setTimer ?? setTimeout;
  const clearTimer = input.deps?.clearTimer ?? clearTimeout;
  const promptDir = path.join(input.request.sandboxRoot, "metadata", "opencode-prompts");
  await fs.mkdir(promptDir, { recursive: true });
  const promptFileName = `${safeFileName(input.request.requestTag)}.md`;
  const promptPath = path.join(promptDir, promptFileName);
  const promptRelativePath = path.posix.join("metadata", "opencode-prompts", promptFileName);
  await fs.writeFile(promptPath, input.request.prompt, "utf-8");

  const outputPath = input.request.outputFile
    ? resolveAgentOutputPath(input.request.sandboxRoot, input.request.outputFile)
    : undefined;
  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    if (!input.request.preserveOutputFileOnStart) {
      await fs.rm(outputPath, { force: true });
    }
  }

  const args = [
    "run",
    "--attach",
    input.runtime.serverUrl,
    "--dir",
    input.request.sandboxRoot,
    "--format",
    "json",
    "--title",
    input.request.title ?? input.request.requestTag,
  ];
  if (input.request.agent) {
    args.push("--agent", input.request.agent);
  }
  if (input.request.continueSessionId) {
    args.push("--session", input.request.continueSessionId);
  }
  const runMessage = input.request.outputFile
    ? `Read and follow the prompt file at ${promptRelativePath}. Write the final JSON object to ${input.request.outputFile}. After writing the file, reply only with {"output_file":"${input.request.outputFile}"}.`
    : `Read and follow the prompt file at ${promptRelativePath}. Return only the requested final JSON object.`;
  args.push(runMessage);
  await logInfo(
    input.request,
    [
      `opencode 调用开始 request=${input.request.requestTag}`,
      `agent=${input.request.agent ?? "default"}`,
      input.request.continueSessionId ? `continueSession=${input.request.continueSessionId}` : undefined,
      `prompt=${promptRelativePath}`,
      input.request.outputFile ? `outputFile=${input.request.outputFile}` : undefined,
    ]
      .filter((part): part is string => typeof part === "string")
      .join(" "),
  );

  return new Promise<OpencodeRunResult>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const child: SpawnedProcess = spawnProcess("opencode", args, {
      env: input.runtime.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timerRef: { current?: NodeJS.Timeout } = {};

    function fail(error: Error): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer(timerRef.current);
      reject(error);
    }

    function succeed(result: OpencodeRunResult): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer(timerRef.current);
      resolve(result);
    }

    timerRef.current = setTimer(() => {
      child.kill("SIGTERM");
      fail(new OpencodeRunError(`opencode 调用超时 request=${input.request.requestTag}`));
    }, input.runtime.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      const bytes = stdout.reduce((sum, item) => sum + item.byteLength, 0);
      if (bytes > input.runtime.maxOutputBytes) {
        child.kill("SIGTERM");
        fail(
          new OpencodeRunError(
            `opencode 输出超过限制 request=${input.request.requestTag} maxOutputBytes=${input.runtime.maxOutputBytes}`,
          ),
        );
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on("error", (error: Error) => {
      fail(new OpencodeRunError(`opencode 进程启动失败 request=${input.request.requestTag}`, { cause: error }));
    });
    child.on("exit", (code: number | null) => {
      if (settled) {
        return;
      }
      void (async () => {
        if (code !== 0) {
          fail(
            new OpencodeRunError(
              `opencode 调用失败 request=${input.request.requestTag} exitCode=${code} stderr=${stderrSnippet(stderr)}`,
            ),
          );
          return;
        }

        const rawEvents = Buffer.concat(stdout).toString("utf-8");
        const modelCallError = extractModelCallError(rawEvents);
        if (modelCallError) {
          throw modelCallError;
        }
        const sessionId = extractSessionId(rawEvents) ?? input.request.continueSessionId;
        const tokenUsage = extractTokenUsage(rawEvents);
        let assistantText: string | undefined;
        let assistantTextError: OpencodeRunError | undefined;
        try {
          assistantText = extractAssistantText(rawEvents);
        } catch (error) {
          assistantTextError =
            error instanceof OpencodeRunError
              ? error
              : new OpencodeRunError(
                  `opencode 输出中缺少 assistant 最终文本 stdoutBytes=${Buffer.byteLength(rawEvents, "utf-8")} eventTypes=${summarizeEventTypes(rawEvents)} stdoutTail=${stdoutTail(rawEvents)}`,
                  { cause: error },
                );
        }
        let rawText = assistantText ?? "";
        let outputFileText: string | undefined;
        if (input.request.outputFile && outputPath) {
          try {
            outputFileText = await fs.readFile(outputPath, "utf-8");
            rawText = outputFileText;
          } catch (error) {
            throw new OpencodeRunError(
              `opencode agent output file missing request=${input.request.requestTag} outputFile=${input.request.outputFile}`,
              { cause: error },
            );
          }
        } else if (assistantTextError) {
          throw assistantTextError;
        }
        const elapsedMs = Date.now() - startedAt;
        await logInfo(
          input.request,
          [
            `opencode 调用完成 request=${input.request.requestTag}`,
            `elapsedMs=${String(elapsedMs)}`,
            sessionId ? `session=${sessionId}` : undefined,
            tokenUsage ? formatTokenUsageLog(tokenUsage) : undefined,
            input.request.outputFile ? `outputFile=${input.request.outputFile}` : undefined,
          ]
            .filter((part): part is string => typeof part === "string")
            .join(" "),
        );
        succeed({
          requestTag: input.request.requestTag,
          rawText,
          rawEvents,
          elapsedMs,
          sessionId,
          tokenUsage,
          assistantText,
          outputFile: input.request.outputFile,
          outputFileText,
        });
      })().catch((error: unknown) => {
        fail(error instanceof Error ? error : new OpencodeRunError(String(error)));
      });
    });
  });
}

import type { OpencodeRunRequest, OpencodeRunResult, OpencodeTokenUsage } from "../opencode/cliRunner.js";
import { parseOpencodeRawEventStream } from "./partParser.js";
import type { AgentTraceAttempt, AgentTraceEvent, AgentTraceRun } from "./types.js";

type RuntimeSummary = {
  serverUrl?: string;
  runtimeDir?: string;
};

type AgentTraceRecorderInput = {
  taskId?: number;
  caseId?: string;
  caseDir: string;
  runtime?: RuntimeSummary;
  now?: () => number;
};

type RunGroup = {
  baseRequestTag: string;
  agentName: string;
  attempts: AgentTraceAttempt[];
  events: AgentTraceEvent[];
};

function baseRequestTag(requestTag: string): string {
  return requestTag.replace(/-retry-\d+$/, "");
}

function retryIndex(requestTag: string): number {
  const match = /-retry-(\d+)$/.exec(requestTag);
  return match ? Number(match[1]) : 0;
}

function runIdFor(base: string): string {
  return `atr_${base.replace(/[^A-Za-z0-9_.-]+/g, "_")}`;
}

function attemptIdFor(base: string, index: number): string {
  return `${runIdFor(base)}_attempt_${String(index)}`;
}

function latestTokenUsage(attempts: AgentTraceAttempt[]): OpencodeTokenUsage | undefined {
  for (const attempt of [...attempts].reverse()) {
    if (attempt.tokenUsage) {
      return attempt.tokenUsage;
    }
  }
  return undefined;
}

function firstDefinedText(
  attempts: AgentTraceAttempt[],
  key: "prompt" | "assistantText" | "outputFile" | "outputFileText",
): string | undefined {
  for (const attempt of [...attempts].reverse()) {
    const value = attempt[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function groupStatus(attempts: AgentTraceAttempt[]): AgentTraceRun["status"] {
  return attempts.some((attempt) => attempt.status === "success") ? "success" : "failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type AgentTraceRecorder = {
  runPrompt(
    request: OpencodeRunRequest,
    run: (request: OpencodeRunRequest) => Promise<OpencodeRunResult>,
  ): Promise<OpencodeRunResult>;
  drainRuns(): AgentTraceRun[];
};

export function createAgentTraceRecorder(input: AgentTraceRecorderInput): AgentTraceRecorder {
  const groups = new Map<string, RunGroup>();
  const now = input.now ?? Date.now;

  function groupFor(request: OpencodeRunRequest): RunGroup {
    const base = baseRequestTag(request.requestTag);
    const existing = groups.get(base);
    if (existing) {
      return existing;
    }
    const group: RunGroup = {
      baseRequestTag: base,
      agentName: request.agent ?? "default",
      attempts: [],
      events: [],
    };
    groups.set(base, group);
    return group;
  }

  function pushAttempt(
    request: OpencodeRunRequest,
    startedAtMs: number,
    endedAtMs: number,
    result?: OpencodeRunResult,
    error?: unknown,
  ): void {
    const group = groupFor(request);
    const index = retryIndex(request.requestTag);
    const attempt: AgentTraceAttempt = {
      id: attemptIdFor(group.baseRequestTag, index),
      sequence: group.attempts.length,
      retryIndex: index,
      requestTag: request.requestTag,
      startedAtMs,
      endedAtMs,
      elapsedMs: result?.elapsedMs ?? Math.max(0, endedAtMs - startedAtMs),
      status: error ? "failed" : "success",
      tokenUsage: result?.tokenUsage,
      sessionId: result?.sessionId ?? request.continueSessionId,
      prompt: request.prompt,
      assistantText: result?.assistantText,
      outputFile: result?.outputFile ?? request.outputFile,
      outputFileText: result?.outputFileText,
      warnings: error ? [errorMessage(error)] : [],
    };
    if (result?.rawEvents) {
      const parsed = parseOpencodeRawEventStream(result.rawEvents, attempt);
      attempt.warnings.push(...parsed.warnings);
      const sequenceOffset = group.events.length;
      group.events.push(
        ...parsed.events.map((event, eventIndex) => ({
          ...event,
          sequence: sequenceOffset + eventIndex,
        })),
      );
    }
    group.attempts.push(attempt);
  }

  return {
    async runPrompt(request, run) {
      const startedAtMs = now();
      try {
        const result = await run(request);
        pushAttempt(request, startedAtMs, now(), result);
        return result;
      } catch (error) {
        pushAttempt(request, startedAtMs, now(), undefined, error);
        throw error;
      }
    },

    drainRuns() {
      return Array.from(groups.values()).map((group): AgentTraceRun => {
        const attempts = group.attempts.sort((left, right) => left.sequence - right.sequence);
        const startedAtMs = attempts
          .map((attempt) => attempt.startedAtMs)
          .filter((value): value is number => value !== undefined)
          .at(0);
        const endedAtMs = attempts
          .map((attempt) => attempt.endedAtMs)
          .filter((value): value is number => value !== undefined)
          .at(-1);
        const sessionId = attempts.find((attempt) => attempt.sessionId)?.sessionId;
        return {
          id: runIdFor(group.baseRequestTag),
          taskId: input.taskId,
          caseId: input.caseId,
          baseRequestTag: group.baseRequestTag,
          agentName: group.agentName,
          status: groupStatus(attempts),
          startedAtMs,
          endedAtMs,
          elapsedMs:
            startedAtMs !== undefined && endedAtMs !== undefined
              ? Math.max(0, endedAtMs - startedAtMs)
              : attempts.reduce((sum, attempt) => sum + attempt.elapsedMs, 0),
          tokenUsage: latestTokenUsage(attempts),
          attempts,
          prompt: firstDefinedText(attempts, "prompt"),
          assistantText: firstDefinedText(attempts, "assistantText"),
          outputFile: firstDefinedText(attempts, "outputFile"),
          outputFileText: firstDefinedText(attempts, "outputFileText"),
          opencodeSession: sessionId
            ? {
                id: sessionId,
                title: group.baseRequestTag,
                directory: "",
                source: "api",
              }
            : undefined,
          events: group.events.sort((left, right) => left.sequence - right.sequence),
          warnings: attempts.flatMap((attempt) => attempt.warnings),
        };
      });
    },
  };
}

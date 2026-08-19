import type { OpencodeRunRequest, OpencodeRunResult, OpencodeTokenUsage } from "../opencode/cliRunner.js";

export type AgentTraceRunStatus = "success" | "failed" | "session_missing" | "skipped";

export type OpenCodeTraceEventType =
  | "message"
  | "step-start"
  | "reasoning"
  | "tool"
  | "step-finish"
  | "text"
  | "unknown";

export type AgentTraceEventStatus = "completed" | "error" | "running" | "unknown";

export type AgentTraceEvent = {
  id: string;
  sequence: number;
  attemptId?: string;
  retryIndex?: number;
  type: OpenCodeTraceEventType;
  title: string;
  status?: AgentTraceEventStatus;
  timestampMs?: number;
  elapsedMs?: number;
  tokenUsage?: Partial<OpencodeTokenUsage>;
  toolName?: string;
  messageId?: string;
  partId?: string;
  summary?: string;
  rawPayload?: unknown;
  hasRawPayload?: boolean;
};

export type AgentTraceAttempt = {
  id: string;
  sequence: number;
  retryIndex: number;
  requestTag: string;
  startedAtMs?: number;
  endedAtMs?: number;
  elapsedMs: number;
  status: AgentTraceRunStatus;
  tokenUsage?: OpencodeTokenUsage;
  sessionId?: string;
  prompt?: string;
  assistantText?: string;
  outputFile?: string;
  outputFileText?: string;
  warnings: string[];
};

export type AgentTraceRun = {
  id: string;
  taskId?: number;
  caseId?: string;
  baseRequestTag: string;
  agentName: string;
  nodeId?: string;
  status: AgentTraceRunStatus;
  startedAtMs?: number;
  endedAtMs?: number;
  elapsedMs: number;
  tokenUsage?: OpencodeTokenUsage;
  attempts: AgentTraceAttempt[];
  prompt?: string;
  assistantText?: string;
  outputFile?: string;
  outputFileText?: string;
  opencodeSession?: {
    id: string;
    title: string;
    directory: string;
    createdAtMs?: number;
    updatedAtMs?: number;
    source: "api" | "sqlite";
  };
  opencodeMessages?: unknown[];
  events: AgentTraceEvent[];
  warnings: string[];
};

export type AgentTraceReport = {
  schemaVersion: 1;
  taskId?: number;
  caseId?: string;
  generatedAt: string;
  traceAvailable: boolean;
  runs: AgentTraceRun[];
  summary: {
    runCount: number;
    eventCount: number;
    toolEventCount: number;
    errorCount: number;
    attemptCount: number;
    totalElapsedMs: number;
    totalTokens?: number;
  };
  warnings: string[];
};

export type OpencodeSessionSnapshot = {
  id: string;
  title?: string;
  directory?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  source: "api" | "sqlite";
  messages: Array<{
    info?: Record<string, unknown>;
    parts?: unknown[];
  }>;
};

export type AgentTraceRecordedAttempt = {
  request: OpencodeRunRequest;
  result?: OpencodeRunResult;
  error?: unknown;
  startedAtMs: number;
  endedAtMs: number;
};

export type AgentTraceRunSummary = {
  id: string;
  taskId?: number;
  caseId?: string;
  baseRequestTag: string;
  agentName: string;
  nodeId?: string;
  status: AgentTraceRunStatus;
  startedAtMs?: number;
  endedAtMs?: number;
  elapsedMs: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  opencodeSessionId?: string;
  opencodeServerUrl?: string;
  attemptCount: number;
  eventCount: number;
  toolEventCount: number;
  errorCount: number;
  artifactPath: string;
};

export type AgentTraceAttemptSummary = {
  id: string;
  traceRunId: string;
  taskId?: number;
  sequence: number;
  retryIndex: number;
  requestTag: string;
  status: AgentTraceRunStatus;
  startedAtMs?: number;
  endedAtMs?: number;
  elapsedMs: number;
  totalTokens?: number;
  warningCount: number;
};

export type AgentTraceEventSummary = {
  id: string;
  traceRunId: string;
  traceAttemptId?: string;
  taskId?: number;
  sequence: number;
  retryIndex?: number;
  type: OpenCodeTraceEventType;
  title: string;
  status?: AgentTraceEventStatus;
  timestampMs?: number;
  elapsedMs?: number;
  toolName?: string;
  summary?: string;
  hasRawPayload: boolean;
};

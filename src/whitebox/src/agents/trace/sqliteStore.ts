import type { ScoreDatabase } from "../../datasets/sqlite/database.js";
import type {
  AgentTraceAttemptSummary,
  AgentTraceEventSummary,
  AgentTraceRun,
  AgentTraceRunSummary,
  OpenCodeTraceEventType,
} from "./types.js";

type RunRow = {
  trace_run_id: string;
  task_id: number | null;
  case_id: string | null;
  base_request_tag: string;
  agent_name: string;
  node_id: string | null;
  status: AgentTraceRun["status"];
  started_at_ms: number | null;
  ended_at_ms: number | null;
  elapsed_ms: number;
  total_tokens: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  opencode_session_id: string | null;
  opencode_server_url: string | null;
  attempt_count: number;
  event_count: number;
  tool_event_count: number;
  error_count: number;
  artifact_path: string;
};

type AttemptRow = {
  trace_attempt_id: string;
  trace_run_id: string;
  task_id: number | null;
  sequence: number;
  retry_index: number;
  request_tag: string;
  status: AgentTraceRun["status"];
  started_at_ms: number | null;
  ended_at_ms: number | null;
  elapsed_ms: number;
  total_tokens: number | null;
  warning_count: number;
};

type EventRow = {
  trace_event_id: string;
  trace_run_id: string;
  trace_attempt_id: string | null;
  task_id: number | null;
  sequence: number;
  retry_index: number | null;
  event_type: OpenCodeTraceEventType;
  title: string;
  status: AgentTraceEventSummary["status"] | null;
  timestamp_ms: number | null;
  elapsed_ms: number | null;
  tool_name: string | null;
  summary: string | null;
  has_raw_payload: number;
};

function nullish<T>(value: T | undefined): T | null {
  return value ?? null;
}

function countErrors(run: AgentTraceRun): number {
  return run.events.filter((event) => event.status === "error").length;
}

export type AgentTraceSqliteStore = {
  upsertRun(run: AgentTraceRun, artifactPath: string): Promise<void>;
  listRunsByTaskId(taskId: number): Promise<AgentTraceRunSummary[]>;
  listAttemptsByRunId(traceRunId: string): Promise<AgentTraceAttemptSummary[]>;
  listEventsByRunId(
    traceRunId: string,
    options?: { retryIndex?: number },
  ): Promise<AgentTraceEventSummary[]>;
};

export function createAgentTraceSqliteStore(db: ScoreDatabase): AgentTraceSqliteStore {
  return {
    async upsertRun(run, artifactPath) {
      db.transaction(() => {
        db.run("DELETE FROM agent_trace_event WHERE trace_run_id = ?", [run.id]);
        db.run("DELETE FROM agent_trace_attempt WHERE trace_run_id = ?", [run.id]);
        db.run("DELETE FROM agent_trace_run WHERE trace_run_id = ?", [run.id]);

        db.run(
          `INSERT INTO agent_trace_run (
            trace_run_id, task_id, case_id, base_request_tag, agent_name, node_id, status,
            started_at_ms, ended_at_ms, elapsed_ms, total_tokens, input_tokens, output_tokens,
            reasoning_tokens, cache_read_tokens, cache_write_tokens, opencode_session_id,
            opencode_server_url, attempt_count, event_count, tool_event_count, error_count,
            artifact_path, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            run.id,
            nullish(run.taskId),
            nullish(run.caseId),
            run.baseRequestTag,
            run.agentName,
            nullish(run.nodeId),
            run.status,
            nullish(run.startedAtMs),
            nullish(run.endedAtMs),
            run.elapsedMs,
            nullish(run.tokenUsage?.total),
            nullish(run.tokenUsage?.input),
            nullish(run.tokenUsage?.output),
            nullish(run.tokenUsage?.reasoning),
            nullish(run.tokenUsage?.cacheRead),
            nullish(run.tokenUsage?.cacheWrite),
            nullish(run.opencodeSession?.id),
            null,
            run.attempts.length,
            run.events.length,
            run.events.filter((event) => event.type === "tool").length,
            countErrors(run),
            artifactPath,
            Date.now(),
          ],
        );

        for (const attempt of run.attempts) {
          db.run(
            `INSERT INTO agent_trace_attempt (
              trace_attempt_id, trace_run_id, task_id, sequence, retry_index, request_tag,
              status, started_at_ms, ended_at_ms, elapsed_ms, total_tokens, input_tokens,
              output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, warning_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              attempt.id,
              run.id,
              nullish(run.taskId),
              attempt.sequence,
              attempt.retryIndex,
              attempt.requestTag,
              attempt.status,
              nullish(attempt.startedAtMs),
              nullish(attempt.endedAtMs),
              attempt.elapsedMs,
              nullish(attempt.tokenUsage?.total),
              nullish(attempt.tokenUsage?.input),
              nullish(attempt.tokenUsage?.output),
              nullish(attempt.tokenUsage?.reasoning),
              nullish(attempt.tokenUsage?.cacheRead),
              nullish(attempt.tokenUsage?.cacheWrite),
              attempt.warnings.length,
            ],
          );
        }

        for (const event of run.events) {
          db.run(
            `INSERT INTO agent_trace_event (
              trace_event_id, trace_run_id, trace_attempt_id, task_id, sequence, retry_index,
              event_type, title, status, timestamp_ms, elapsed_ms, tool_name, summary,
              has_raw_payload
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              event.id,
              run.id,
              nullish(event.attemptId),
              nullish(run.taskId),
              event.sequence,
              nullish(event.retryIndex),
              event.type,
              event.title,
              nullish(event.status),
              nullish(event.timestampMs),
              nullish(event.elapsedMs),
              nullish(event.toolName),
              nullish(event.summary),
              event.hasRawPayload || event.rawPayload !== undefined ? 1 : 0,
            ],
          );
        }
      });
    },

    async listRunsByTaskId(taskId) {
      return db
        .all<RunRow>(
          `SELECT trace_run_id, task_id, case_id, base_request_tag, agent_name, node_id, status,
                  started_at_ms, ended_at_ms, elapsed_ms, total_tokens, input_tokens,
                  output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
                  opencode_session_id, opencode_server_url, attempt_count, event_count,
                  tool_event_count, error_count, artifact_path
             FROM agent_trace_run
            WHERE task_id = ?
            ORDER BY started_at_ms, trace_run_id`,
          [taskId],
        )
        .map((row) => ({
          id: row.trace_run_id,
          taskId: row.task_id ?? undefined,
          caseId: row.case_id ?? undefined,
          baseRequestTag: row.base_request_tag,
          agentName: row.agent_name,
          nodeId: row.node_id ?? undefined,
          status: row.status,
          startedAtMs: row.started_at_ms ?? undefined,
          endedAtMs: row.ended_at_ms ?? undefined,
          elapsedMs: row.elapsed_ms,
          totalTokens: row.total_tokens ?? undefined,
          inputTokens: row.input_tokens ?? undefined,
          outputTokens: row.output_tokens ?? undefined,
          reasoningTokens: row.reasoning_tokens ?? undefined,
          cacheReadTokens: row.cache_read_tokens ?? undefined,
          cacheWriteTokens: row.cache_write_tokens ?? undefined,
          opencodeSessionId: row.opencode_session_id ?? undefined,
          opencodeServerUrl: row.opencode_server_url ?? undefined,
          attemptCount: row.attempt_count,
          eventCount: row.event_count,
          toolEventCount: row.tool_event_count,
          errorCount: row.error_count,
          artifactPath: row.artifact_path,
        }));
    },

    async listAttemptsByRunId(traceRunId) {
      return db
        .all<AttemptRow>(
          `SELECT trace_attempt_id, trace_run_id, task_id, sequence, retry_index, request_tag,
                  status, started_at_ms, ended_at_ms, elapsed_ms, total_tokens, warning_count
             FROM agent_trace_attempt
            WHERE trace_run_id = ?
            ORDER BY sequence`,
          [traceRunId],
        )
        .map((row) => ({
          id: row.trace_attempt_id,
          traceRunId: row.trace_run_id,
          taskId: row.task_id ?? undefined,
          sequence: row.sequence,
          retryIndex: row.retry_index,
          requestTag: row.request_tag,
          status: row.status,
          startedAtMs: row.started_at_ms ?? undefined,
          endedAtMs: row.ended_at_ms ?? undefined,
          elapsedMs: row.elapsed_ms,
          totalTokens: row.total_tokens ?? undefined,
          warningCount: row.warning_count,
        }));
    },

    async listEventsByRunId(traceRunId, options) {
      const params: Array<string | number> = [traceRunId];
      const retryFilter = options?.retryIndex === undefined ? "" : " AND retry_index = ?";
      if (options?.retryIndex !== undefined) {
        params.push(options.retryIndex);
      }
      return db
        .all<EventRow>(
          `SELECT trace_event_id, trace_run_id, trace_attempt_id, task_id, sequence, retry_index,
                  event_type, title, status, timestamp_ms, elapsed_ms, tool_name, summary,
                  has_raw_payload
             FROM agent_trace_event
            WHERE trace_run_id = ?${retryFilter}
            ORDER BY sequence`,
          params,
        )
        .map((row) => ({
          id: row.trace_event_id,
          traceRunId: row.trace_run_id,
          traceAttemptId: row.trace_attempt_id ?? undefined,
          taskId: row.task_id ?? undefined,
          sequence: row.sequence,
          retryIndex: row.retry_index ?? undefined,
          type: row.event_type,
          title: row.title,
          status: row.status ?? undefined,
          timestampMs: row.timestamp_ms ?? undefined,
          elapsedMs: row.elapsed_ms ?? undefined,
          toolName: row.tool_name ?? undefined,
          summary: row.summary ?? undefined,
          hasRawPayload: Number(row.has_raw_payload) === 1,
        }));
    },
  };
}

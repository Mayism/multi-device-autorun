import {
  buildAgentTraceReport,
  writeAgentTraceArtifacts,
} from "../../agents/trace/artifactStore.js";
import type { AgentTraceRecorder } from "../../agents/trace/recorder.js";
import { parseOpencodeSessionEvents } from "../../agents/trace/partParser.js";
import { fetchOpencodeSessionSnapshot } from "../../agents/trace/sessionClient.js";
import type { AgentTraceRun } from "../../agents/trace/types.js";
import type { OpencodeRuntimeConfig } from "../../agents/opencode/config.js";
import type { ArtifactStore } from "../../commons/io/artifactStore.js";
import type { CaseLogger } from "../../commons/io/caseLogger.js";

type OpencodeSessionSnapshot = NonNullable<
  Awaited<ReturnType<typeof fetchOpencodeSessionSnapshot>>
>;

function readRunSessionId(run: AgentTraceRun): string | undefined {
  return run.opencodeSession?.id ?? run.attempts.find((attempt) => attempt.sessionId)?.sessionId;
}

function buildTraceSession(snapshot: OpencodeSessionSnapshot, run: AgentTraceRun) {
  return {
    id: snapshot.id,
    title: snapshot.title ?? run.baseRequestTag,
    directory: snapshot.directory ?? "",
    createdAtMs: snapshot.createdAtMs,
    updatedAtMs: snapshot.updatedAtMs,
    source: snapshot.source,
  };
}

async function enrichAgentTraceRun(input: {
  run: AgentTraceRun;
  runtime: OpencodeRuntimeConfig;
  logger: CaseLogger;
}): Promise<AgentTraceRun> {
  const sessionId = readRunSessionId(input.run);
  if (!sessionId) {
    return input.run;
  }
  try {
    const snapshot = await fetchOpencodeSessionSnapshot({
      serverUrl: input.runtime.serverUrl,
      runtimeDir: input.runtime.runtimeDir,
      sessionId,
    });
    return snapshot ? mergeRunSnapshot(input.run, snapshot) : markMissingSession(input.run);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.logger.warn(`agent trace session 读取失败 session=${sessionId} warning=${message}`);
    return { ...input.run, warnings: [...input.run.warnings, "opencode_session_read_failed"] };
  }
}

function markMissingSession(run: AgentTraceRun): AgentTraceRun {
  return {
    ...run,
    status: run.status === "success" ? "session_missing" : run.status,
    warnings: [...run.warnings, "opencode_session_not_found"],
  };
}

function mergeRunSnapshot(run: AgentTraceRun, snapshot: OpencodeSessionSnapshot): AgentTraceRun {
  const parsed = parseOpencodeSessionEvents(snapshot, run.attempts);
  const session = buildTraceSession(snapshot, run);
  if (parsed.events.length === 0 && run.events.length > 0) {
    return {
      ...run,
      opencodeSession: session,
      opencodeMessages: snapshot.messages,
      warnings: [...run.warnings, ...parsed.warnings, "opencode_session_messages_empty"],
    };
  }
  return {
    ...run,
    opencodeSession: session,
    opencodeMessages: snapshot.messages,
    events: parsed.events.length > 0 ? parsed.events : run.events,
    warnings: [...run.warnings, ...parsed.warnings],
  };
}

/**
 * 将 Agent 调用轨迹补齐为可审计报告。
 *
 * trace recorder 先记录 CLI 调用侧的事件；这里再按 OpenCode session id
 * 拉取服务端消息快照，补齐模型消息、工具调用和解析失败告警。
 */
export async function enrichAgentTraceRuns(input: {
  runs: AgentTraceRun[];
  runtime?: OpencodeRuntimeConfig;
  logger: CaseLogger;
}): Promise<AgentTraceRun[]> {
  if (!input.runtime) {
    return input.runs;
  }
  const enriched: AgentTraceRun[] = [];
  for (const run of input.runs) {
    enriched.push(await enrichAgentTraceRun({ run, runtime: input.runtime, logger: input.logger }));
  }
  return enriched;
}

/** 将本次 workflow 中收集到的 Agent trace 写入 case artifact。 */
export async function writeWorkflowAgentTrace(input: {
  artifactStore: ArtifactStore;
  caseDir: string;
  traceRecorder?: AgentTraceRecorder;
  runtime?: OpencodeRuntimeConfig;
  logger: CaseLogger;
}): Promise<void> {
  const runs = input.traceRecorder?.drainRuns() ?? [];
  if (runs.length === 0) {
    return;
  }
  try {
    const enrichedRuns = await enrichAgentTraceRuns({
      runs,
      runtime: input.runtime,
      logger: input.logger,
    });
    await writeAgentTraceArtifacts({
      artifactStore: input.artifactStore,
      caseDir: input.caseDir,
      report: buildAgentTraceReport({ runs: enrichedRuns }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.logger.warn(`agent trace 写入失败 warning=${message}`);
  }
}

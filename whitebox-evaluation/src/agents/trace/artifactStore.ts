import type { ArtifactStore } from "../../commons/io/artifactStore.js";
import type { AgentTraceReport, AgentTraceRun } from "./types.js";

function summarize(runs: AgentTraceRun[]): AgentTraceReport["summary"] {
  const totalTokens = runs.reduce((sum, run) => sum + (run.tokenUsage?.total ?? 0), 0);
  return {
    runCount: runs.length,
    eventCount: runs.reduce((sum, run) => sum + run.events.length, 0),
    toolEventCount: runs.reduce(
      (sum, run) => sum + run.events.filter((event) => event.type === "tool").length,
      0,
    ),
    errorCount: runs.reduce(
      (sum, run) => sum + run.events.filter((event) => event.status === "error").length,
      0,
    ),
    attemptCount: runs.reduce((sum, run) => sum + run.attempts.length, 0),
    totalElapsedMs: runs.reduce((sum, run) => sum + run.elapsedMs, 0),
    totalTokens: totalTokens > 0 ? totalTokens : undefined,
  };
}

export function buildAgentTraceReport(input: {
  taskId?: number;
  caseId?: string;
  runs: AgentTraceRun[];
  warnings?: string[];
}): AgentTraceReport {
  return {
    schemaVersion: 1,
    taskId: input.taskId,
    caseId: input.caseId,
    generatedAt: new Date().toISOString(),
    traceAvailable: input.runs.length > 0,
    runs: input.runs,
    summary: summarize(input.runs),
    warnings: input.warnings ?? [],
  };
}

export async function writeAgentTraceArtifacts(input: {
  artifactStore: ArtifactStore;
  caseDir: string;
  report: AgentTraceReport;
}): Promise<void> {
  await input.artifactStore.writeJson(input.caseDir, "outputs/agent-trace.json", input.report);
}

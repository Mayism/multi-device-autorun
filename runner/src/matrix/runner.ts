import fs from "node:fs/promises";
import path from "node:path";
import { loadExecutionConfig } from "../execution/config.js";
import { buildExecutionPlan } from "../execution/plan.js";
import { runExecution } from "../execution/runner.js";
import { renderSummaryMarkdown } from "./result.js";
import { RunnerLogger } from "../logging/logger.js";
import { formatRunnerError } from "../logging/types.js";
import type { MatrixResult, RunMatrixInput } from "./types/index.js";

export async function runOhosTestMatrix(
  input: RunMatrixInput,
): Promise<MatrixResult> {
  const startedTime = Date.now();
  const project = path.resolve(input.project);
  const out = resolveMatrixOut(input, project, startedTime);
  const outDir = path.dirname(out);
  await fs.mkdir(outDir, { recursive: true });
  const logger = RunnerLogger.create(path.join(outDir, "commands.jsonl"), {
    phase: "matrix",
  });
  try {
    const config = await loadExecutionConfig({
      project,
      machineConfigPath: input.machineConfigPath,
      testClass: input.testClass,
      testCaseTimeoutMs: input.testCaseTimeoutMs,
    });
    const execution = await runExecution({
      config,
      plan: buildExecutionPlan(config, {
        devices: input.devices,
        testClass: input.testClass ?? config.testClass,
      }),
      outDir,
      skipBuild: input.skipBuild,
      keepEmulators: input.keepEmulators,
      commandExecutor: input.commandExecutor,
      logger,
    });
    const result: MatrixResult = {
      schemaVersion: "ohostest-matrix-v1",
      ...execution,
      artifacts: {
        commandLog: "commands.jsonl",
        summary: "summary.md",
      },
    };
    await writeMatrixArtifacts(result, out, outDir);
    return result;
  } catch (error) {
    logger.recordError(error);
    const result = failedMatrixResult(project, startedTime, error);
    await writeMatrixArtifacts(result, out, outDir);
    return result;
  } finally {
    await logger.close();
  }
}

function failedMatrixResult(
  project: string,
  startedTime: number,
  error: unknown,
): MatrixResult {
  const message = formatRunnerError(error);
  const finishedTime = Date.now();
  return {
    schemaVersion: "ohostest-matrix-v1",
    project,
    status: "failed",
    startedAt: new Date(startedTime).toISOString(),
    finishedAt: new Date(finishedTime).toISOString(),
    durationMs: finishedTime - startedTime,
    build: {
      status: "blocked",
      appHap: "",
      testHap: "",
      blockedReason: message,
    },
    devices: [],
    diagnostics: [message],
    artifacts: {
      commandLog: "commands.jsonl",
      summary: "summary.md",
    },
  };
}

async function writeMatrixArtifacts(
  result: MatrixResult,
  out: string,
  outDir: string,
): Promise<void> {
  await fs.writeFile(
    path.join(outDir, "summary.md"),
    renderSummaryMarkdown(result.status, result.devices),
    "utf-8",
  );
  await fs.writeFile(out, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
}

function resolveMatrixOut(
  input: RunMatrixInput,
  project: string,
  startedTime: number,
): string {
  return path.resolve(
    input.out ??
      path.join(
        project,
        ".ohostest-runs",
        timestampForPath(new Date(startedTime)),
        "result.json",
      ),
  );
}

function timestampForPath(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

import fs from "node:fs/promises";
import path from "node:path";
import { createManagedOpencodeRunner } from "./agents/opencode/managedRunner.js";
import { createOpencodeRuntimeConfig } from "./agents/opencode/config.js";
import {
  createOpencodeServeManager,
  ensureOpencodeCliAvailable,
} from "./agents/opencode/serveManager.js";
import { ArtifactStore } from "./commons/io/artifactStore.js";
import { CaseLogger } from "./commons/io/caseLogger.js";
import { runPreparedScoreWorkflow } from "./workflow/graph/scoreWorkflow.js";
import type { ScoreGraphState } from "./workflow/graph/state.js";
import { taskUnderstandingNode } from "./workflow/nodes/taskUnderstanding/index.js";
import type { CaseInput } from "./types.js";
import type {
  LocalWhiteboxInput,
  LocalWhiteboxRunSummary,
} from "./localContracts.js";
import { writeWhiteboxHtml } from "./report/renderHtml.js";

async function countFiles(root: string): Promise<number> {
  let count = 0;
  async function visit(current: string): Promise<void> {
    const entries = await fs
      .readdir(current, { withFileTypes: true })
      .catch(() => []);
    await Promise.all(
      entries.map(async (entry) => {
        if (
          [
            ".git",
            ".hvigor",
            "node_modules",
            "oh_modules",
            "build",
            "dist",
          ].includes(entry.name)
        )
          return;
        const target = path.join(current, entry.name);
        if (entry.isDirectory()) await visit(target);
        else if (entry.isFile()) count += 1;
      }),
    );
  }
  await visit(root);
  return count;
}

async function assertInput(input: LocalWhiteboxInput): Promise<void> {
  if (input.schemaVersion !== "whitebox-input-v1")
    throw new Error("不支持的白盒输入版本");
  for (const [key, value] of Object.entries({
    caseId: input.caseId,
    promptPath: input.promptPath,
    originalProjectPath: input.originalProjectPath,
    generatedProjectPath: input.generatedProjectPath,
    patchPath: input.patchPath,
    outputDir: input.outputDir,
  })) {
    if (typeof value !== "string" || !value.trim())
      throw new Error(`${key} 不能为空`);
  }
  await Promise.all([
    fs.access(input.promptPath),
    fs.access(input.originalProjectPath),
    fs.access(input.generatedProjectPath),
    fs.access(input.patchPath),
  ]);
}

export async function runLocalWhiteboxEvaluation(
  input: LocalWhiteboxInput,
  options: { repoRoot?: string; port?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<LocalWhiteboxRunSummary> {
  await assertInput(input);
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const outputDir = path.resolve(input.outputDir);
  await fs.mkdir(outputDir, { recursive: true });
  const promptText = await fs.readFile(input.promptPath, "utf-8");
  const caseInput: CaseInput = {
    caseId: input.caseId,
    promptText,
    originalProjectPath: path.resolve(input.originalProjectPath),
    generatedProjectPath: path.resolve(input.generatedProjectPath),
    originalProjectProvided: true,
    patchPath: path.resolve(input.patchPath),
    expectedConstraintsPath: input.expectedConstraintsPath
      ? path.resolve(input.expectedConstraintsPath)
      : undefined,
  };
  const artifactStore = new ArtifactStore(path.dirname(outputDir));
  const logger = new CaseLogger(artifactStore, outputDir);
  const runtimeEnv = options.env ?? process.env;
  await ensureOpencodeCliAvailable();
  const runtimeToken = [
    input.metadata?.batchId,
    input.caseId,
    options.port ?? runtimeEnv.HMOS_OPENCODE_PORT ?? "default",
  ]
    .filter(Boolean)
    .join("-")
    .replace(/[^0-9A-Za-z._-]+/g, "-");
  const runtime = await createOpencodeRuntimeConfig({
    repoRoot,
    env: runtimeEnv,
    port: options.port,
    runtimeName: `case-${runtimeToken}`,
  });
  const serveManager = createOpencodeServeManager(runtime);
  const runner = createManagedOpencodeRunner({ runtime, serveManager });
  const agentBuildResult = input.agentBuild ?? {
    source: "agent" as const,
    status:
      input.buildSuccess === true
        ? ("success" as const)
        : input.buildSuccess === false
          ? ("failed" as const)
          : ("not_run" as const),
    finalAttemptStatus:
      input.buildSuccess === true
        ? ("succeeded" as const)
        : input.buildSuccess === false
          ? ("failed" as const)
          : ("not_run" as const),
    attempts: [],
    summary: {
      attempts: 0,
      succeeded: input.buildSuccess === true ? 1 : 0,
      failed: input.buildSuccess === false ? 1 : 0,
      interrupted: 0,
      running: 0,
    },
  };

  try {
    await serveManager.start();
    const initialState = {
      caseDir: outputDir,
      caseInput,
      taskType: input.taskType,
      inputMode: "autorun_local",
      agentBuildResult,
    } as ScoreGraphState;
    const understandingUpdate = await taskUnderstandingNode(initialState, {
      opencode: runner,
      artifactStore,
      logger,
    });
    const prepared = {
      ...initialState,
      ...understandingUpdate,
    } as ScoreGraphState;
    const originalFileCount = await countFiles(caseInput.originalProjectPath);
    const workspaceFileCount = await countFiles(caseInput.generatedProjectPath);
    const result = await runPreparedScoreWorkflow({
      caseDir: outputDir,
      referenceRoot: path.join(repoRoot, "references", "scoring"),
      artifactStore,
      opencodeRunner: runner,
      preparedState: {
        caseInput: prepared.caseInput,
        sourceCasePath: path.dirname(caseInput.originalProjectPath),
        remoteTaskRootDir: outputDir,
        inputMode: "autorun_local",
        originalFileCount,
        workspaceFileCount,
        hasPatch: prepared.hasPatch ?? true,
        agentBuildResult,
        caseDir: outputDir,
        effectivePatchPath: prepared.effectivePatchPath ?? caseInput.patchPath!,
        caseRuleDefinitions: prepared.caseRuleDefinitions ?? [],
        taskUnderstanding: prepared.taskUnderstanding,
        taskType: input.taskType,
        changedFiles: prepared.changedFiles ?? [],
        changedLineNumbersByFile: prepared.changedLineNumbersByFile ?? {},
        changedFileCount:
          prepared.changedFileCount ?? prepared.changedFiles?.length ?? 0,
      },
    });
    const resultJson = (result.resultJson ?? {}) as Record<string, unknown>;
    const resultPath = path.join(outputDir, "outputs", "result.json");
    const reportPath = path.join(outputDir, "report.html");
    await writeWhiteboxHtml(resultJson, reportPath);
    const overall = (resultJson.overall_conclusion ?? {}) as Record<
      string,
      unknown
    >;
    return {
      status: "completed",
      caseId: input.caseId,
      outputDir,
      resultPath,
      reportPath,
      totalScore:
        typeof overall.total_score === "number"
          ? overall.total_score
          : undefined,
      hardGateTriggered: overall.hard_gate_triggered === true,
    };
  } finally {
    await serveManager.stop();
  }
}

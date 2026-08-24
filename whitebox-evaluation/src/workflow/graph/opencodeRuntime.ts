import {
  createOpencodeRuntimeConfig,
  type OpencodeRuntimeConfig,
} from "../../agents/opencode/config.js";
import {
  createOpencodeServeManager,
  ensureOpencodeCliAvailable,
} from "../../agents/opencode/serveManager.js";
import type { OpencodeWorkflowRuntime, WorkflowCommonInput } from "./types.js";

let sharedOpencodeRuntime: Promise<OpencodeWorkflowRuntime> | undefined;

async function createOpencodeWorkflowRuntime(): Promise<OpencodeWorkflowRuntime> {
  await ensureOpencodeCliAvailable();
  const runtime = await createOpencodeRuntimeConfig({ repoRoot: process.cwd() });
  const serveManager = createOpencodeServeManager(runtime);
  await serveManager.start();
  return { runtime, serveManager };
}

/**
 * 为 workflow 准备 OpenCode 运行时。
 *
 * 调用方可以显式注入 runtime/runner；未注入时默认复用 shared runtime，
 * 只有 lifecycle=ephemeral 时才为单次执行创建并在 finally 中清理。
 */
export async function prepareOpencodeRuntime(
  input: WorkflowCommonInput,
): Promise<WorkflowCommonInput> {
  if (input.opencodeRuntime) {
    if (input.opencodeServeManager) {
      await input.opencodeServeManager.start();
    }
    return input;
  }

  if (input.opencodeRunner) {
    return input;
  }

  if (input.opencodeRuntimeLifecycle === "ephemeral") {
    const ephemeral = await createOpencodeWorkflowRuntime();
    return {
      ...input,
      opencodeRuntime: ephemeral.runtime,
      opencodeServeManager: ephemeral.serveManager,
    };
  }

  sharedOpencodeRuntime ??= createOpencodeWorkflowRuntime();
  let shared: OpencodeWorkflowRuntime;
  try {
    shared = await sharedOpencodeRuntime;
  } catch (error) {
    sharedOpencodeRuntime = undefined;
    throw error;
  }
  return {
    ...input,
    opencodeRuntime: shared.runtime,
    opencodeServeManager: shared.serveManager,
  };
}

/** 按 lifecycle 执行 workflow，并负责 ephemeral runtime 的退出清理。 */
export async function runWithOpencodeRuntimeLifecycle(
  input: WorkflowCommonInput,
  run: (preparedInput: WorkflowCommonInput) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const preparedInput = await prepareOpencodeRuntime(input);
  try {
    return await run(preparedInput);
  } finally {
    if (preparedInput.opencodeRuntimeLifecycle === "ephemeral") {
      await preparedInput.opencodeServeManager?.stop();
    }
  }
}

export type { OpencodeRuntimeConfig };

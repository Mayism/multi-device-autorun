import type { OpencodeRunRequest, OpencodeRunResult } from "./cliRunner.js";
import { runOpencodePrompt } from "./cliRunner.js";
import type { OpencodeRuntimeConfig } from "./config.js";
import type { OpencodeServeManager } from "./serveManager.js";

export type ManagedOpencodeRunner = {
  runPrompt(request: OpencodeRunRequest): Promise<OpencodeRunResult>;
};

type ManagedOpencodeRunnerInput = {
  runtime: OpencodeRuntimeConfig;
  serveManager: Pick<OpencodeServeManager, "start" | "restart">;
  runPrompt?: (input: {
    runtime: OpencodeRuntimeConfig;
    request: OpencodeRunRequest;
  }) => Promise<OpencodeRunResult>;
};

function isRecoverableOpencodeRuntimeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /session\s+not\s+found/i.test(message) ||
    /ECONNREFUSED|ECONNRESET|socket hang up|fetch failed/i.test(message) ||
    /opencode serve 提前退出|opencode serve 健康检查超时/.test(message)
  );
}

export function createManagedOpencodeRunner(input: ManagedOpencodeRunnerInput): ManagedOpencodeRunner {
  const runPrompt = input.runPrompt ?? runOpencodePrompt;
  let activeRuns = 0;
  let restartInProgress: Promise<void> | undefined;
  const idleWaiters: Array<() => void> = [];

  function releaseActiveRun(): void {
    activeRuns -= 1;
    if (activeRuns === 0) {
      const waiters = idleWaiters.splice(0, idleWaiters.length);
      waiters.forEach((resolve) => resolve());
    }
  }

  async function waitForIdle(): Promise<void> {
    if (activeRuns === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      idleWaiters.push(resolve);
    });
  }

  async function waitForRestart(): Promise<void> {
    while (restartInProgress) {
      await restartInProgress;
    }
  }

  async function restartWhenIdle(): Promise<void> {
    if (!restartInProgress) {
      restartInProgress = (async () => {
        await waitForIdle();
        await input.serveManager.restart();
      })();
      try {
        await restartInProgress;
      } finally {
        restartInProgress = undefined;
      }
      return;
    }
    await restartInProgress;
  }

  async function runAttempt(request: OpencodeRunRequest): Promise<OpencodeRunResult> {
    await waitForRestart();
    activeRuns += 1;
    try {
      await input.serveManager.start();
      return await runPrompt({ runtime: input.runtime, request });
    } finally {
      releaseActiveRun();
    }
  }

  return {
    async runPrompt(request: OpencodeRunRequest): Promise<OpencodeRunResult> {
      try {
        return await runAttempt(request);
      } catch (error) {
        if (!isRecoverableOpencodeRuntimeError(error)) {
          throw error;
        }
        await restartWhenIdle();
        return await runAttempt(request);
      }
    },
  };
}

import { createManagedOpencodeRunner } from "./managedRunner.js";
import {
  createOpencodeRuntimeConfig,
  type OpencodeRuntimeConfig,
} from "./config.js";
import type { OpencodeRunRequest, OpencodeRunResult } from "./cliRunner.js";
import {
  createOpencodeServeManager,
  ensureOpencodeCliAvailable,
  type OpencodeServeManager,
} from "./serveManager.js";

export type PooledOpencodeRunner = {
  runPrompt(request: OpencodeRunRequest): Promise<OpencodeRunResult>;
};

export type OpencodeRunnerLease = {
  slotId: number;
  runner: PooledOpencodeRunner;
  release(): void;
};

type RunnerSlot = {
  slotId: number;
  runtime: OpencodeRuntimeConfig;
  serveManager: OpencodeServeManager;
  runner: PooledOpencodeRunner;
  leased: boolean;
};

type AcquireWaiter = {
  resolve: (lease: OpencodeRunnerLease) => void;
};

export type OpencodeRunnerPool = {
  acquire(): Promise<OpencodeRunnerLease>;
  stopAll(): Promise<void>;
};

type CreateRuntimeInput = {
  slotId: number;
  port: number;
  runtimeName: string;
};

export type OpencodeRunnerPoolInput = {
  size: number;
  basePort: number;
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  createRuntimeConfig?: (input: CreateRuntimeInput) => Promise<OpencodeRuntimeConfig>;
  createServeManager?: (runtime: OpencodeRuntimeConfig) => OpencodeServeManager;
  ensureCliAvailable?: () => Promise<void>;
  runPrompt?: (input: {
    runtime: OpencodeRuntimeConfig;
    request: OpencodeRunRequest;
  }) => Promise<OpencodeRunResult>;
};

function assertPoolInput(input: OpencodeRunnerPoolInput): void {
  if (!Number.isInteger(input.size) || input.size <= 0) {
    throw new Error("opencode runner pool size must be a positive integer");
  }
  if (!Number.isInteger(input.basePort) || input.basePort <= 0) {
    throw new Error("opencode runner pool basePort must be a positive integer");
  }
}

export function createOpencodeRunnerPool(input: OpencodeRunnerPoolInput): OpencodeRunnerPool {
  assertPoolInput(input);
  const ensureCli = input.ensureCliAvailable ?? ensureOpencodeCliAvailable;
  const createRuntime =
    input.createRuntimeConfig ??
    ((runtimeInput: CreateRuntimeInput) =>
      createOpencodeRuntimeConfig({
        repoRoot: input.repoRoot ?? process.cwd(),
        env: input.env,
        port: runtimeInput.port,
        runtimeName: runtimeInput.runtimeName,
      }));
  const createServeManagerForRuntime = input.createServeManager ?? createOpencodeServeManager;
  const slots: RunnerSlot[] = [];
  const waiters: AcquireWaiter[] = [];
  let initPromise: Promise<void> | undefined;

  async function init(): Promise<void> {
    if (initPromise) {
      return initPromise;
    }
    initPromise = (async () => {
      const initializedSlots: RunnerSlot[] = [];
      await ensureCli();
      try {
        for (let slotId = 0; slotId < input.size; slotId += 1) {
          const runtime = await createRuntime({
            slotId,
            port: input.basePort + slotId,
            runtimeName: `worker-${String(slotId)}`,
          });
          const serveManager = createServeManagerForRuntime(runtime);
          await serveManager.start();
          const runner = createManagedOpencodeRunner({
            runtime,
            serveManager,
            runPrompt: input.runPrompt,
          });
          initializedSlots.push({
            slotId,
            runtime,
            serveManager,
            runner,
            leased: false,
          });
        }
      } catch (error) {
        await Promise.allSettled(initializedSlots.map((slot) => slot.serveManager.stop()));
        throw error;
      }
      slots.splice(0, slots.length, ...initializedSlots);
    })();
    try {
      await initPromise;
    } catch (error) {
      initPromise = undefined;
      throw error;
    }
  }

  function makeLease(slot: RunnerSlot): OpencodeRunnerLease {
    let released = false;
    return {
      slotId: slot.slotId,
      runner: slot.runner,
      release() {
        if (released) {
          return;
        }
        released = true;
        releaseSlot(slot);
      },
    };
  }

  function leaseAvailableSlot(): OpencodeRunnerLease | undefined {
    const slot = slots.find((candidate) => !candidate.leased);
    if (!slot) {
      return undefined;
    }
    slot.leased = true;
    return makeLease(slot);
  }

  function releaseSlot(slot: RunnerSlot): void {
    const waiter = waiters.shift();
    if (waiter) {
      slot.leased = true;
      waiter.resolve(makeLease(slot));
      return;
    }
    slot.leased = false;
  }

  return {
    async acquire(): Promise<OpencodeRunnerLease> {
      await init();
      const lease = leaseAvailableSlot();
      if (lease) {
        return lease;
      }
      return new Promise<OpencodeRunnerLease>((resolve) => {
        waiters.push({ resolve });
      });
    },

    async stopAll(): Promise<void> {
      if (!initPromise && slots.length === 0) {
        return;
      }
      await init();
      waiters.splice(0, waiters.length);
      await Promise.all(slots.map((slot) => slot.serveManager.stop()));
    },
  };
}

import { setTimeout as sleep } from "node:timers/promises";
import type { OwnedProcess, ProcessExit, ProcessInput } from "./process.js";
import {
  loadWindowsJob,
  windowsCommand,
  windowsEnvironment,
  type NativeJob,
  type WindowsJobApi,
} from "./windowsJob.js";

export function startWindowsProcess(input: ProcessInput): OwnedProcess {
  const api = loadWindowsJob();
  const job = api.launch(
    input.file,
    windowsCommand(input.file, input.args),
    input.cwd,
    input.log,
    windowsEnvironment(input.env ?? process.env),
  );
  return new WindowsProcess(api, job).owned;
}

class WindowsProcess {
  readonly owned: OwnedProcess;
  private readonly child: {
    pid: number;
    exitCode: number | null;
    signalCode: null;
  };
  private resolveExit!: (exit: ProcessExit) => void;
  private rejectExit!: (error: unknown) => void;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly api: WindowsJobApi,
    private readonly job: NativeJob,
  ) {
    this.child = { pid: job.pid, exitCode: null, signalCode: null };
    this.owned = {
      child: this.child,
      closed: new Promise<ProcessExit>((resolve, reject) => {
        this.resolveExit = resolve;
        this.rejectExit = reject;
      }),
      windowsJob: { refresh: () => this.refresh(), stop: () => this.stop() },
    };
    // Readiness may observe a polling failure before anyone awaits closed.
    void this.owned.closed.catch(() => undefined);
    this.timer = setTimeout(() => this.poll(), 0);
  }

  private refresh() {
    const state = this.api.poll(this.job);
    if (state.code !== null && this.owned.child.exitCode === null) {
      this.child.exitCode = state.code;
      this.owned.exit = { code: state.code };
      clearTimeout(this.timer);
      this.resolveExit(this.owned.exit);
    }
    return state;
  }

  private poll(): void {
    try {
      this.refresh();
      if (!this.owned.exit) this.timer = setTimeout(() => this.poll(), 25);
    } catch (error) {
      this.owned.exit = { code: null, error: String(error) };
      this.rejectExit(error);
    }
  }

  private async stop(): Promise<void> {
    // Keep the Job even after root exit: npm may leave descendants behind.
    this.api.terminate(this.job);
    const deadline = performance.now() + 5000;
    while (true) {
      const state = this.refresh();
      if (state.active === 0 && state.code !== null) break;
      if (performance.now() >= deadline)
        throw new Error(
          `web_job_stop_timeout: root=${this.job.pid}, active=${state.active}`,
        );
      await sleep(25);
    }
    clearTimeout(this.timer);
    this.api.close(this.job);
  }
}

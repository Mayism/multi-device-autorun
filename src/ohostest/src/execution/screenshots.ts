import fs from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { CommandResult } from "./types/index.js";
import { shellQuote } from "./utils/shellQuote.js";
import { sleep } from "./utils/sleep.js";

const remoteShotDir = "/data/local/tmp";

/** Cadence of the rolling capture tracking the screen during each test case. */
export const screenshotIntervalMs = 1000;

export interface ScreenCaptureInput {
  /** Quoted `hdc -t <target>` prefix built by hdcFor(). */
  hdc: string;
  /** Absolute directory receiving the captured files. */
  localDir: string;
  /** Absolute run output directory used to compute stored relative paths. */
  outDir: string;
  /** Stem for the rolling pending file, e.g. `SmPassToPassTest-1`. */
  prefix: string;
  /** Unlock-retry attempt index (>=2 gets a name suffix to avoid overwrites). */
  attempt: number;
  run: (command: string) => Promise<CommandResult>;
  onCapture?: (relativePath: string) => void;
}

/**
 * Keeps one screenshot per failing test case. While the test command runs, a
 * rolling capture overwrites a single pending frame every few seconds; when
 * a test case reports a failure, the pending frame - taken while that case
 * was executing, before any teardown - is renamed after it and the loop keeps
 * rolling for further failing cases. A case that fails before any frame was
 * taken gets one immediate best-effort shot. Passing, ignored cases and runs
 * without failures leave nothing behind; when the command settles, a
 * leftover pending frame belongs to the case that never reported (hang or
 * timeout) and is kept under its name. Snapshot failures never interrupt.
 */
export class DeviceScreenCapture {
  private readonly input: ScreenCaptureInput;
  private readonly pendingLocal: string;
  private readonly pendingRemote: string;
  private lastTestCase: string | undefined;
  private readonly reportedTestCases = new Set<string>();
  private readonly shotTestCases = new Set<string>();
  private stopped = false;
  private hasPendingFrame = false;
  /** Epoch of the running test case; bumped when a case starts. */
  private caseEpoch = 0;
  /** Epoch the pending frame was captured in; -1 when stale or absent. */
  private pendingEpoch = -1;
  private loop: Promise<void> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private interruptWait: (() => void) | undefined;

  constructor(input: ScreenCaptureInput) {
    this.input = input;
    this.pendingLocal = path.join(
      input.localDir,
      `${input.prefix}-pending.jpeg`,
    );
    this.pendingRemote = `${remoteShotDir}/${input.prefix}-pending.jpeg`;
  }

  /** Feed one stdout line of the live aa test stream. */
  onTestOutputLine(line: string): void {
    const clean = stripVTControlCharacters(line).trim();
    const name = /^OHOS_REPORT_STATUS: test=(.+)$/.exec(clean)?.[1]?.trim();
    if (name) {
      this.lastTestCase = name;
      return;
    }
    if (!this.lastTestCase || this.stopped) return;
    const code = /^OHOS_REPORT_STATUS_CODE:\s*(-?\d+)$/.exec(clean)?.[1];
    if (code === undefined) return;
    // STATUS_CODE: 1 running, 0 passed, -3 ignored; anything else failed.
    const value = Number(code);
    if (value === 1) {
      // The case just started: frames taken before now show the previous
      // case or the app startup, never this case's own scene.
      this.caseEpoch += 1;
      this.pendingEpoch = -1;
      return;
    }
    const testCase = this.lastTestCase;
    if (this.reportedTestCases.has(testCase)) return;
    this.reportedTestCases.add(testCase);
    if (value === 0 || value === -3) return;
    if (this.shotTestCases.has(testCase)) return;
    this.shotTestCases.add(testCase);
    // Serialize promotions so quick consecutive failures cannot interleave.
    this.queue = this.queue.then(() =>
      this.promote(testCase).catch(() => undefined),
    );
  }

  /** Starts the rolling capture tracking the screen during the run. */
  startDuringLoop(intervalMs: number = screenshotIntervalMs): void {
    if (this.loop) return;
    this.loop = this.runRollingLoop(intervalMs);
  }

  /** Settles rolling and promotions; keeps a leftover frame for a hung case. */
  async finish(): Promise<void> {
    this.stopped = true;
    this.interruptWait?.();
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
    await this.queue.catch(() => undefined);
    this.queue = Promise.resolve();
    if (
      this.hasPendingFrame &&
      this.lastTestCase &&
      !this.reportedTestCases.has(this.lastTestCase)
    ) {
      // The command ended before that case reported (hang or timeout);
      // its pending frame is the best evidence of the stuck scene.
      await this.promote(this.lastTestCase).catch(() => undefined);
      return;
    }
    await fs.rm(this.pendingLocal, { force: true }).catch(() => undefined);
    await this.input
      .run(`${this.input.hdc} shell rm ${this.pendingRemote}`)
      .catch(() => undefined);
  }

  private async runRollingLoop(intervalMs: number): Promise<void> {
    while (!this.stopped) {
      await this.wait(intervalMs);
      if (this.stopped) return;
      const saved = await this.captureTo(
        this.pendingLocal,
        this.pendingRemote,
      );
      if (saved) {
        this.hasPendingFrame = true;
        this.pendingEpoch = this.caseEpoch;
      }
    }
  }

  private async promote(testCase: string): Promise<void> {
    const stem = `${safeFileName(testCase)}${
      this.input.attempt > 1 ? `-${this.input.attempt}` : ""
    }`;
    const finalLocal = path.join(this.input.localDir, `${stem}.jpeg`);
    if (this.hasPendingFrame && this.pendingEpoch === this.caseEpoch) {
      // The pending frame was captured while this very case was executing.
      this.hasPendingFrame = false;
      this.pendingEpoch = -1;
      await fs.rename(this.pendingLocal, finalLocal).catch(() => undefined);
      this.input.onCapture?.(path.relative(this.input.outDir, finalLocal));
      await this.input
        .run(`${this.input.hdc} shell rm ${this.pendingRemote}`)
        .catch(() => undefined);
      return;
    }
    // No fresh frame for this case (startup or a prior case): shoot now.
    const saved = await this.captureTo(
      finalLocal,
      `${remoteShotDir}/${stem}.jpeg`,
    );
    if (saved) {
      this.input.onCapture?.(path.relative(this.input.outDir, finalLocal));
    }
  }

  private async captureTo(local: string, remote: string): Promise<boolean> {
    try {
      await fs.mkdir(this.input.localDir, { recursive: true });
      const shot = await this.input.run(
        `${this.input.hdc} shell snapshot_display -f ${remote}`,
      );
      if (shot.exitCode !== 0) return false;
      const recv = await this.input.run(
        `${this.input.hdc} file recv ${remote} ${shellQuote(local)}`,
      );
      // hdc may report success without producing the file; verify before keeping it.
      const saved =
        recv.exitCode === 0
          ? await fs.stat(local).catch(() => undefined)
          : undefined;
      await this.input.run(`${this.input.hdc} shell rm ${remote}`);
      return saved?.isFile() ?? false;
    } catch {
      return false;
    }
  }

  private wait(intervalMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.interruptWait = undefined;
        resolve();
      }, intervalMs);
      this.interruptWait = () => {
        clearTimeout(timer);
        this.interruptWait = undefined;
        resolve();
      };
    });
  }
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

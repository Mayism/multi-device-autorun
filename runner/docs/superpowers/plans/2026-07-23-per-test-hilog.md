# Per-Test HiLog Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture only the current HarmonyOS test package's hilog, associate it with individual ohosTest cases, persist complete logs, and print bounded excerpts for failed cases.

**Architecture:** Add a streaming command primitive for `aa test` and filtered `hdc hilog` processes. A focused `hilog.ts` module will build the device-side package regex, verify the process name of every returned line, track Hypium case boundaries, and write suite/case artifacts; the matrix runner will attach artifact paths to parsed results. Shared failure rendering will let both matrix and case CLIs print only failed-case excerpts.

**Tech Stack:** TypeScript 6, Node.js `child_process.spawn`, Node test runner, HarmonyOS `hdc`, Hypium `OHOS_REPORT_STATUS`, ArkTS `@kit.PerformanceAnalysisKit`.

---

## File Structure

- Create `src/matrix/hilog.ts`: package-filtered hilog command construction, line verification, Hypium boundary tracking, artifact writing, and suite capture orchestration.
- Create `src/matrix/failureOutput.ts`: render failed-case log excerpts for matrix and case CLI entry points.
- Modify `src/shared/types/command.ts`: streaming command interfaces.
- Modify `src/shared/command.ts`: default spawn-based streaming executor and logged lifecycle support.
- Modify `src/matrix/types/index.ts`: injectable streaming executor and per-case log metadata.
- Modify `src/matrix/runner.ts`: run suites through the hilog capture orchestrator.
- Modify `src/matrix/result.ts`: add per-case log links to matrix summary.
- Modify `scripts/runOhosTestMatrix.ts`: print failed-case log excerpts even when matrix execution completed.
- Modify `scripts/runOhosTestCase.ts`: print failed-case excerpts for SWE/Answer runs.
- Modify `src/index.ts`: export failure rendering only if scripts consume it through the package entry point.
- Modify `ResponsiveRepeatLayout/answer/products/entry/src/ohosTest/ets/test/MdFailToPass.test.ets`: add a unique real hilog probe to a layout case.
- Create `tests/hilog.test.ts`: pure filtering, boundary tracking, and capture orchestration tests.
- Create `tests/failure-output.test.ts`: bounded failure rendering tests.
- Modify `tests/command.test.ts`, `tests/runner.test.ts`, and `tests/result.test.ts`: streaming lifecycle, integration, artifacts, and summary coverage.
- Modify `README.md` and `docs/usage/matrix.md`: document package-filtered hilog artifacts and terminal behavior.

### Task 1: Streaming Command Primitive

**Files:**
- Modify: `harmonyos-ohostest-runner/src/shared/types/command.ts`
- Modify: `harmonyos-ohostest-runner/src/shared/command.ts`
- Test: `harmonyos-ohostest-runner/tests/command.test.ts`

- [ ] **Step 1: Write failing tests for chunk callbacks and stop**

Add a test that starts a Node child process which emits two stdout chunks and remains alive:

```typescript
test("defaultStreamingCommandExecutor streams output and can stop the child", async () => {
  const stdout: string[] = [];
  const running = defaultStreamingCommandExecutor(
    `${shellQuote(process.execPath)} -e "process.stdout.write('first\\\\n');setTimeout(()=>process.stdout.write('second\\\\n'),20);setInterval(()=>{},1000)"`,
    process.cwd(),
    { onStdout: (text) => stdout.push(text) },
  );

  await new Promise((resolve) => setTimeout(resolve, 80));
  await running.stop();
  const result = await running.result;

  assert.match(stdout.join(""), /first/);
  assert.match(stdout.join(""), /second/);
  assert.match(result.stdout, /first/);
  assert.match(result.stdout, /second/);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
cd harmonyos-ohostest-runner
node --import tsx --test tests/command.test.ts
```

Expected: FAIL because `defaultStreamingCommandExecutor` and streaming types do not exist.

- [ ] **Step 3: Add streaming command types**

Add to `src/shared/types/command.ts`:

```typescript
export interface StreamingCommandCallbacks {
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

export interface RunningCommand {
  result: Promise<CommandResult>;
  stop(): Promise<void>;
}

export type StreamingCommandExecutor = (
  command: string,
  cwd: string,
  callbacks: StreamingCommandCallbacks,
) => RunningCommand;
```

Export these types from `src/shared/types/index.ts`.

- [ ] **Step 4: Implement the spawn-based executor**

Add to `src/shared/command.ts`:

```typescript
export const defaultStreamingCommandExecutor: StreamingCommandExecutor = (
  command,
  cwd,
  callbacks,
) => {
  const started = Date.now();
  const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = decodeCommandOutput(chunk);
    stdout += text;
    callbacks.onStdout?.(text);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = decodeCommandOutput(chunk);
    stderr += text;
    callbacks.onStderr?.(text);
  });

  const result = new Promise<CommandResult>((resolve) => {
    child.on("error", (error) => {
      resolve({
        stdout,
        stderr: stderr || error.message,
        exitCode: 1,
        durationMs: Date.now() - started,
      });
    });
    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0,
        durationMs: Date.now() - started,
      });
    });
  });

  return {
    result,
    async stop(): Promise<void> {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      await result;
    },
  };
};
```

Guard promise settlement once so an `error` followed by `close` cannot resolve twice.

- [ ] **Step 5: Run the focused tests**

Run:

```bash
node --import tsx --test tests/command.test.ts
```

Expected: all command tests PASS and the spawned process exits after `stop()`.

- [ ] **Step 6: Commit**

```bash
git add harmonyos-ohostest-runner/src/shared/command.ts harmonyos-ohostest-runner/src/shared/types/command.ts harmonyos-ohostest-runner/src/shared/types/index.ts harmonyos-ohostest-runner/tests/command.test.ts
git commit -m "feat: add streaming command execution"
```

### Task 2: Package-Filtered HiLog Parser and Case Boundary Tracker

**Files:**
- Create: `harmonyos-ohostest-runner/src/matrix/hilog.ts`
- Create: `harmonyos-ohostest-runner/tests/hilog.test.ts`

- [ ] **Step 1: Write failing package-filter tests**

Cover regex escaping, mandatory device-side filtering, exact process validation, sub-process acceptance, and rejection of system lines which merely mention the bundle in their message:

```typescript
test("buildFilteredHilogCommand escapes bundle regex and never builds an unfiltered command", () => {
  const command = buildFilteredHilogCommand({
    hdc: "/fake/hdc",
    target: "127.0.0.1:15002",
    bundleName: "zhsc.1.xxxxxx",
  });
  assert.match(command, /hilog -e/);
  assert.match(command, /zhsc\\\\\\.1\\\\\\.xxxxxx/);
});

test("isHilogLineForBundle verifies the process field", () => {
  assert.equal(
    isHilogLineForBundle(
      "07-23 12:00:00.000 120-121/zhsc.1.xxxxxx I 00000/Test: probe",
      "zhsc.1.xxxxxx",
    ),
    true,
  );
  assert.equal(
    isHilogLineForBundle(
      "07-23 12:00:00.000 120-121/zhsc.1.xxxxxx:test I 00000/Test: probe",
      "zhsc.1.xxxxxx",
    ),
    true,
  );
  assert.equal(
    isHilogLineForBundle(
      "07-23 12:00:00.000 1-1/foundation I 00000/Test: zhsc.1.xxxxxx",
      "zhsc.1.xxxxxx",
    ),
    false,
  );
});
```

- [ ] **Step 2: Write failing boundary tests**

Feed `OHOS_REPORT_STATUS` in split chunks and interleave hilog lines:

```typescript
test("HilogCaseTracker assigns logs only while the matching case is running", () => {
  const tracker = new HilogCaseTracker("zhsc.1.xxxxxx");
  tracker.acceptAaStdout("OHOS_REPORT_STATUS: test=first\\nOHOS_REPORT_STATUS_CO");
  tracker.acceptAaStdout("DE: 1\\n");
  tracker.acceptHilog(
    "07-23 12:00:00.000 120-121/zhsc.1.xxxxxx I 00000/Test: first-log\\n",
  );
  tracker.acceptAaStdout("OHOS_REPORT_STATUS: test=first\\nOHOS_REPORT_STATUS_CODE: -2\\n");
  tracker.acceptHilog(
    "07-23 12:00:00.100 120-121/zhsc.1.xxxxxx I 00000/Test: between\\n",
  );
  tracker.acceptAaStdout("OHOS_REPORT_STATUS: test=second\\nOHOS_REPORT_STATUS_CODE: 1\\n");
  tracker.acceptHilog(
    "07-23 12:00:00.200 120-121/zhsc.1.xxxxxx I 00000/Test: second-log\\n",
  );

  assert.deepEqual(tracker.caseLines("first"), [
    "07-23 12:00:00.000 120-121/zhsc.1.xxxxxx I 00000/Test: first-log",
  ]);
  assert.deepEqual(tracker.caseLines("second"), [
    "07-23 12:00:00.200 120-121/zhsc.1.xxxxxx I 00000/Test: second-log",
  ]);
  assert.doesNotMatch(tracker.suiteLines().join("\\n"), /foundation/);
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
node --import tsx --test tests/hilog.test.ts
```

Expected: FAIL because `src/matrix/hilog.ts` does not exist.

- [ ] **Step 4: Implement command construction and strict process parsing**

Create `src/matrix/hilog.ts` with these public helpers:

```typescript
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildFilteredHilogCommand(input: {
  hdc: string;
  target: string;
  bundleName: string;
}): string {
  const filter = escapeRegex(input.bundleName);
  if (!filter) {
    throw new Error("hilog_bundle_filter_empty");
  }
  return [
    shellQuote(input.hdc),
    "-t",
    shellQuote(input.target),
    "hilog",
    "-e",
    shellQuote(filter),
  ].join(" ");
}

export function processNameFromHilogLine(line: string): string | undefined {
  return /^\S+\s+\S+\s+\d+-\d+\/(\S+)\s+[DIWEF]\s+/.exec(line)?.[1];
}

export function isHilogLineForBundle(line: string, bundleName: string): boolean {
  const processName = processNameFromHilogLine(line);
  return processName === bundleName || processName?.startsWith(`${bundleName}:`) === true;
}
```

The command must always contain `-e`; do not add an overload that constructs unfiltered hilog.

- [ ] **Step 5: Implement reusable line buffering and tracker**

Implement a line buffer whose `push()` returns complete lines and whose `flush()` returns the final partial line. Implement `HilogCaseTracker` with:

```typescript
export class HilogCaseTracker {
  private candidateTest?: string;
  private activeTest?: string;
  private readonly aaLines = new LineBuffer();
  private readonly hilogLines = new LineBuffer();
  private readonly fullLog: string[] = [];
  private readonly byCase = new Map<string, string[]>();

  constructor(private readonly bundleName: string) {}

  acceptAaStdout(text: string): void {
    for (const line of this.aaLines.push(text)) {
      this.acceptAaLine(line);
    }
  }

  acceptHilog(text: string): void {
    for (const line of this.hilogLines.push(text)) {
      if (!isHilogLineForBundle(line, this.bundleName)) continue;
      this.fullLog.push(line);
      if (this.activeTest) {
        const lines = this.byCase.get(this.activeTest) ?? [];
        lines.push(line);
        this.byCase.set(this.activeTest, lines);
      }
    }
  }

  suiteLines(): string[] {
    return [...this.fullLog];
  }

  caseLines(name: string): string[] {
    return [...(this.byCase.get(name) ?? [])];
  }

  private acceptAaLine(line: string): void {
    const test = /^OHOS_REPORT_STATUS:\s+test=(.+)$/.exec(line)?.[1];
    if (test) {
      this.candidateTest = test;
      return;
    }
    const codeText = /^OHOS_REPORT_STATUS_CODE:\s*(-?\d+)$/.exec(line)?.[1];
    if (codeText === undefined || !this.candidateTest) return;
    const code = Number(codeText);
    if (code === 1) {
      this.activeTest = this.candidateTest;
      return;
    }
    if (this.activeTest === this.candidateTest) {
      this.activeTest = undefined;
    }
  }
}
```

Flush both buffers at shutdown and process their final complete content.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --import tsx --test tests/hilog.test.ts
```

Expected: all filtering and boundary tests PASS.

- [ ] **Step 7: Commit**

```bash
git add harmonyos-ohostest-runner/src/matrix/hilog.ts harmonyos-ohostest-runner/tests/hilog.test.ts
git commit -m "feat: track package hilog by test case"
```

### Task 3: HiLog Capture Lifecycle and Artifacts

**Files:**
- Modify: `harmonyos-ohostest-runner/src/matrix/hilog.ts`
- Modify: `harmonyos-ohostest-runner/src/matrix/types/index.ts`
- Test: `harmonyos-ohostest-runner/tests/hilog.test.ts`

- [ ] **Step 1: Write a failing orchestration test**

Inject fake streaming processes. Assert the hilog command includes the escaped package filter, the `aa test` chunks create two case windows, only valid package lines are written, and `stop()` is called:

```typescript
test("captureSuiteHilog writes filtered suite and case artifacts", async (t) => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ohostest-hilog-"));
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  const started: string[] = [];
  let hilogStopped = false;

  const result = await captureSuiteHilog({
    hdc: "/fake/hdc",
    target: "127.0.0.1:15002",
    bundleName: "zhsc.1.xxxxxx",
    deviceId: "foldable",
    suiteClass: "MdFailToPassTest",
    outDir,
    testCommand: "/fake/hdc aa test",
    runStreaming(command, callbacks) {
      started.push(command);
      if (command.includes(" hilog ")) {
        callbacks.onStdout?.(
          "07-23 12:00:00.000 10-11/zhsc.1.xxxxxx I 00000/Test: probe\\n" +
            "07-23 12:00:00.001 1-1/foundation I 00000/Test: zhsc.1.xxxxxx\\n",
        );
        return {
          result: new Promise(() => undefined),
          async stop() { hilogStopped = true; },
        };
      }
      callbacks.onStdout?.(
        "OHOS_REPORT_STATUS: test=layout\\nOHOS_REPORT_STATUS_CODE: 1\\n",
      );
      callbacks.onStdout?.(
        "OHOS_REPORT_STATUS: test=layout\\nOHOS_REPORT_STATUS_CODE: -2\\n" +
          "OHOS_REPORT_RESULT: stream=Tests run: 1, Failure: 1, Error: 0, Pass: 0, Ignore: 0\\n" +
          "OHOS_REPORT_CODE: -1\\n",
      );
      return {
        result: Promise.resolve({ stdout: "", stderr: "", exitCode: 0, durationMs: 1 }),
        async stop() {},
      };
    },
    diagnostics: [],
  });

  assert.match(started[0], /hilog -e/);
  assert.equal(hilogStopped, true);
  assert.match(await fs.readFile(result.suiteLogFile, "utf-8"), /probe/);
  assert.doesNotMatch(await fs.readFile(result.suiteLogFile, "utf-8"), /foundation/);
});
```

Adjust the fake so the hilog probe is emitted after the running status callback, ensuring it belongs to `layout`.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
node --import tsx --test tests/hilog.test.ts
```

Expected: FAIL because `captureSuiteHilog` is not implemented.

- [ ] **Step 3: Add result metadata types**

Extend `TestCaseRunResult`:

```typescript
export interface TestCaseRunResult {
  name: string;
  status: TestCaseRunStatus;
  statusCode: number;
  logFile?: string;
  logExcerpt?: string[];
}
```

Extend `RunMatrixInput` with:

```typescript
streamingCommandExecutor?: StreamingCommandExecutor;
```

Keep both additions optional so existing programmatic callers remain compatible.

- [ ] **Step 4: Implement `captureSuiteHilog`**

The function must:

1. Start `buildFilteredHilogCommand()` before `aa test`.
2. Start `aa test` with stdout routed to `tracker.acceptAaStdout`.
3. Route hilog stdout to `tracker.acceptHilog`.
4. Await the test result.
5. Stop hilog in `finally`.
6. Treat hilog startup/exit/parse failures as diagnostics, not test failures.
7. Write `devices/<device>/<suite>.hilog.log`.
8. Write non-empty case logs under `devices/<device>/cases/<suite>/<case>.hilog.log`.
9. Return the original `CommandResult` plus a `Map<string, CaseHilogArtifact>`.

Use this artifact shape:

```typescript
export interface CaseHilogArtifact {
  logFile: string;
  logExcerpt: string[];
}

export interface SuiteHilogCaptureResult {
  testResult: CommandResult;
  suiteLogFile?: string;
  caseArtifacts: Map<string, CaseHilogArtifact>;
}
```

Limit `logExcerpt` to the final 80 lines. Store paths relative to `outDir`; return absolute paths only from internal file-writing helpers.

- [ ] **Step 5: Ensure unsupported filtering cannot fall back**

Add a test where the filtered hilog process exits with stderr `unknown option -e`. Assert:

- the diagnostics array contains `hilog_filter_unavailable`;
- no second hilog command is started;
- no command equal to plain `hilog` is constructed;
- the `aa test` result is returned unchanged.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --import tsx --test tests/hilog.test.ts
```

Expected: all hilog tests PASS.

- [ ] **Step 7: Commit**

```bash
git add harmonyos-ohostest-runner/src/matrix/hilog.ts harmonyos-ohostest-runner/src/matrix/types/index.ts harmonyos-ohostest-runner/tests/hilog.test.ts
git commit -m "feat: persist filtered hilog artifacts"
```

### Task 4: Integrate Capture into Matrix Execution and Summary

**Files:**
- Modify: `harmonyos-ohostest-runner/src/matrix/runner.ts`
- Modify: `harmonyos-ohostest-runner/src/matrix/result.ts`
- Modify: `harmonyos-ohostest-runner/tests/runner.test.ts`
- Modify: `harmonyos-ohostest-runner/tests/result.test.ts`

- [ ] **Step 1: Write a failing runner integration test**

Inject both buffered and streaming executors. Stream one failed case and one matching hilog line, then assert:

```typescript
assert.equal(
  result.devices[0]?.suiteResults[0]?.testCases[0]?.logFile,
  "devices/phone/cases/MdFailToPassTest/layout.hilog.log",
);
assert.deepEqual(
  result.devices[0]?.suiteResults[0]?.testCases[0]?.logExcerpt,
  ["07-23 12:00:00.000 10-11/zhsc.1.xxxxxx I 00000/Test: probe"],
);
```

Also verify the referenced file exists below the output directory and contains only the package line.

- [ ] **Step 2: Run runner and result tests to verify failure**

Run:

```bash
node --import tsx --test tests/runner.test.ts tests/result.test.ts
```

Expected: FAIL because runner does not use streaming capture and summary has no `Log` column.

- [ ] **Step 3: Add logged streaming execution to matrix context**

Extend `MatrixRunContext` and `DeviceRunInput` with `runStreaming`. In `createMatrixRunContext`, select:

```typescript
const streamingExecutor =
  input.streamingCommandExecutor ?? defaultStreamingCommandExecutor;
```

Wrap it so every completed streaming command is recorded by `CommandLogger`, while `stop()` still delegates to the underlying running process.

- [ ] **Step 4: Route both suite execution paths through one helper**

Create an internal `executeTestSuite(input, suiteClass, testClass?)` which calls `captureSuiteHilog`, parses the returned `testResult`, and merges artifacts:

```typescript
function attachCaseHilog(
  testCases: TestCaseRunResult[],
  artifacts: Map<string, CaseHilogArtifact>,
): TestCaseRunResult[] {
  return testCases.map((testCase) => {
    const artifact = artifacts.get(testCase.name);
    return artifact ? { ...testCase, ...artifact } : testCase;
  });
}
```

Use it from both `runSuite` and `runAllSuites`, preserving their current failed/blocked semantics. Push the original `aaTestStdout` and `aaTestStderr` into device logs exactly as before.

- [ ] **Step 5: Add matrix summary log links**

Change the case table to:

```markdown
| Test Case | Status | Code | Log |
| --- | --- | ---: | --- |
```

Render `testCase.logFile` as `[hilog](<relative-path>)`, otherwise render an empty cell. Escape `|` in paths if necessary.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --import tsx --test tests/runner.test.ts tests/result.test.ts tests/hilog.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 7: Commit**

```bash
git add harmonyos-ohostest-runner/src/matrix/runner.ts harmonyos-ohostest-runner/src/matrix/result.ts harmonyos-ohostest-runner/tests/runner.test.ts harmonyos-ohostest-runner/tests/result.test.ts
git commit -m "feat: attach hilog to matrix case results"
```

### Task 5: Failed-Case Terminal Output for Matrix and Case CLIs

**Files:**
- Create: `harmonyos-ohostest-runner/src/matrix/failureOutput.ts`
- Create: `harmonyos-ohostest-runner/tests/failure-output.test.ts`
- Modify: `harmonyos-ohostest-runner/scripts/runOhosTestMatrix.ts`
- Modify: `harmonyos-ohostest-runner/scripts/runOhosTestCase.ts`
- Modify: `harmonyos-ohostest-runner/src/index.ts`

- [ ] **Step 1: Write failing rendering tests**

Build a matrix result with passed and failed cases. Assert output includes only the failed case:

```typescript
test("renderFailedCaseHilog prints only failed cases with bounded excerpts", () => {
  const lines = Array.from({ length: 81 }, (_, index) => `line-${index + 1}`);
  const output = renderFailedCaseHilog(matrixResultWithCases([
    { name: "passes", status: "passed", statusCode: 0, logExcerpt: ["pass-log"] },
    {
      name: "fails",
      status: "failed",
      statusCode: -2,
      logFile: "devices/foldable/cases/Suite/fails.hilog.log",
      logExcerpt: lines,
    },
  ]));

  assert.match(output, /fails/);
  assert.match(output, /line-81/);
  assert.match(output, /hilog\\.log/);
  assert.doesNotMatch(output, /pass-log/);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
node --import tsx --test tests/failure-output.test.ts
```

Expected: FAIL because `renderFailedCaseHilog` does not exist.

- [ ] **Step 3: Implement shared rendering**

Create:

```typescript
export function renderFailedCaseHilog(
  result: MatrixResult,
  label?: string,
): string {
  const lines: string[] = [];
  for (const device of result.devices) {
    for (const suite of device.suiteResults) {
      for (const testCase of suite.testCases) {
        if (testCase.status === "passed" || testCase.status === "ignored") continue;
        lines.push(
          `✗ ${label ? `${label} / ` : ""}${device.id} / ${suite.suiteClass} / ${testCase.name}`,
          `  hilog: ${testCase.logFile ?? "(未捕获到当前包日志)"}`,
        );
        const excerpt = testCase.logExcerpt ?? [];
        if (excerpt.length > 0) {
          lines.push(...excerpt.slice(-80).map((line) => `  ${line}`));
        }
      }
    }
  }
  return lines.join("\n");
}
```

Keep rendering pure; scripts decide whether to use `console.error`.

- [ ] **Step 4: Integrate both scripts**

In matrix mode, render failed-case hilog regardless of matrix-level `status`; a completed matrix can still contain failed tests.

In case mode, render `swe` and `answer` separately:

```typescript
for (const [label, run] of Object.entries(result.runs)) {
  if (!run) continue;
  const failedHilog = renderFailedCaseHilog(run, label);
  if (failedHilog) console.error(failedHilog);
}
```

Do not print passed/ignored hilog.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
node --import tsx --test tests/failure-output.test.ts tests/cli.test.ts
npm run build
```

Expected: tests PASS and TypeScript build exits 0.

- [ ] **Step 6: Commit**

```bash
git add harmonyos-ohostest-runner/src/matrix/failureOutput.ts harmonyos-ohostest-runner/src/index.ts harmonyos-ohostest-runner/scripts/runOhosTestMatrix.ts harmonyos-ohostest-runner/scripts/runOhosTestCase.ts harmonyos-ohostest-runner/tests/failure-output.test.ts
git commit -m "feat: print failed case hilog excerpts"
```

### Task 6: Documentation, Full Verification, and Real Foldable Probe

**Files:**
- Modify: `harmonyos-ohostest-runner/README.md`
- Modify: `harmonyos-ohostest-runner/docs/usage/matrix.md`
- Modify: `ResponsiveRepeatLayout/answer/products/entry/src/ohosTest/ets/test/MdFailToPass.test.ets`

- [ ] **Step 1: Document output and filtering behavior**

Document:

- hilog is filtered on-device with escaped `bundleName`;
- runner verifies each returned process field;
- no unfiltered fallback occurs;
- complete suite and case logs are stored below `devices/<device>/`;
- only failed-case excerpts print by default;
- hilog collection diagnostics do not change test verdicts.

- [ ] **Step 2: Add a unique ArkTS probe**

Add the import:

```typescript
import { hilog } from '@kit.PerformanceAnalysisKit';
```

At the start of `should_show_home_waterflow_as_multi_column_layout_on_medium_breakpoint`, add:

```typescript
hilog.info(
  0x0000,
  'OHOSTEST_HILOG_PROBE',
  '%{public}s',
  'MdFailToPassTest should_show_home_waterflow_as_multi_column_layout_on_medium_breakpoint',
);
```

Keep the log because it is a useful diagnostic marker for this layout test and contains no private data.

- [ ] **Step 3: Run complete automated verification**

Run:

```bash
cd harmonyos-ohostest-runner
npm test
npm run lint
npm run build
```

Expected: all tests PASS; lint and TypeScript build exit 0.

- [ ] **Step 4: Check available targets and start the configured foldable run**

Run:

```bash
/Users/guoyutong/command-line-tools/sdk/default/openharmony/toolchains/hdc list targets
npm run ohostest:matrix -- \
  --project ../ResponsiveRepeatLayout/answer \
  --device foldable \
  --test-class MdFailToPassTest \
  --out ../ResponsiveRepeatLayout/answer/.ohostest-runs/hilog-validation/result.json
```

Expected: the runner starts the configured `Mate X7` emulator when necessary, builds and installs both HAPs, runs only `MdFailToPassTest`, and writes `result.json`.

- [ ] **Step 5: Inspect validation artifacts**

Run:

```bash
rg -n "OHOSTEST_HILOG_PROBE|MdFailToPassTest" \
  ../ResponsiveRepeatLayout/answer/.ohostest-runs/hilog-validation/devices
node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync("../ResponsiveRepeatLayout/answer/.ohostest-runs/hilog-validation/result.json","utf8"));console.log(JSON.stringify(r.devices.flatMap(d=>d.suiteResults.flatMap(s=>s.testCases.map(t=>({device:d.id,suite:s.suiteClass,name:t.name,status:t.status,logFile:t.logFile})))),null,2))'
```

Expected:

- the unique probe appears in the suite log and target case log;
- it does not appear in the neighboring layout case log;
- every stored hilog line has process name `zhsc.1.xxxxxx` or a `zhsc.1.xxxxxx:` prefix;
- `result.json` points to existing files;
- `summary.md` contains the hilog link.

- [ ] **Step 6: Review command log for the no-full-log invariant**

Run:

```bash
rg -n "\\bhilog\\b" ../ResponsiveRepeatLayout/answer/.ohostest-runs/hilog-validation/commands.log
```

Expected: every hilog invocation includes `-e` followed by the escaped bundle filter; no plain unfiltered hilog invocation exists.

- [ ] **Step 7: Commit documentation and probe**

```bash
git add harmonyos-ohostest-runner/README.md harmonyos-ohostest-runner/docs/usage/matrix.md ResponsiveRepeatLayout/answer/products/entry/src/ohosTest/ets/test/MdFailToPass.test.ets
git commit -m "docs: document per-test hilog capture"
```

- [ ] **Step 8: Final repository verification**

Run:

```bash
git status --short
git log -7 --oneline
```

Expected: no uncommitted implementation changes remain; the recent commits correspond to streaming execution, filtering/tracking, artifacts, runner integration, failure output, and documentation/probe.

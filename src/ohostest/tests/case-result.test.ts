import assert from "node:assert/strict";
import test from "node:test";
import { renderCaseSummary } from "../src/case/result.js";
import type { CaseResult } from "../src/index.js";
import type {
  DeviceRunResult,
  MatrixResult,
  SuiteRunResult,
  TestCaseRunResult,
} from "../src/matrix/types/index.js";

function suite(
  suiteClass: string,
  status: SuiteRunResult["status"],
  testsRun: number,
  failures: number,
  testCases: TestCaseRunResult[] = [],
): SuiteRunResult {
  return {
    suiteClass,
    status,
    testsRun,
    failures,
    errors: 0,
    passes: testsRun - failures,
    ignored: 0,
    reportCode: failures === 0 ? 0 : -1,
    ok: failures === 0,
    testCases,
  };
}

function testCase(
  name: string,
  status: TestCaseRunResult["status"],
): TestCaseRunResult {
  return {
    name,
    status,
    statusCode: status === "passed" ? 0 : -1,
  };
}

function device(id: string, suiteResults: SuiteRunResult[]): DeviceRunResult {
  const totals = suiteResults.reduce(
    (aggregate, item) => ({
      testsRun: aggregate.testsRun + item.testsRun,
      failures: aggregate.failures + item.failures,
      errors: aggregate.errors + item.errors,
      passes: aggregate.passes + item.passes,
      ignored: aggregate.ignored + item.ignored,
    }),
    { testsRun: 0, failures: 0, errors: 0, passes: 0, ignored: 0 },
  );
  return {
    id,
    target: `127.0.0.1:${id}`,
    status: totals.failures === 0 && totals.errors === 0 ? "passed" : "failed",
    ...totals,
    suiteResults,
    durationMs: 1,
    log: `${id}.log`,
  };
}

function matrix(devices: DeviceRunResult[]): MatrixResult {
  return {
    schemaVersion: "ohostest-matrix-v1",
    project: "/tmp/project",
    status: "completed",
    startedAt: "2026-07-02T00:00:00.000Z",
    finishedAt: "2026-07-02T00:00:01.000Z",
    durationMs: 1,
    build: {
      status: "passed",
      appHap: "/tmp/app.hap",
      testHap: "/tmp/test.hap",
    },
    devices,
    artifacts: {
      commandLog: "commands.jsonl",
      summary: "summary.md",
    },
    diagnostics: [],
  };
}

function baseCaseResult(
  runs: CaseResult["runs"],
  metadata: CaseResult["metadata"] = {
    testCaseTimeoutMs: 15000,
    passToPass: ["should_launch", "should_keep_small"],
    failToPass: ["should_adapt_medium", "should_adapt_large"],
    deviceTestSuites: {
      foldable: [{ suite: "CommonSmokeTest" }, { suite: "MdAdaptiveSuite" }],
      tablet: [{ suite: "LargeScreenSuite" }],
    },
  },
): CaseResult {
  return {
    schemaVersion: "ohostest-case-v1",
    caseId: "responsive-repeat-layout",
    caseDir: "/tmp/case",
    baseProject: "/tmp/case/task",
    startedAt: "2026-07-02T00:00:00.000Z",
    finishedAt: "2026-07-02T00:00:01.000Z",
    durationMs: 1,
    status: "completed",
    metadata,
    runs,
    artifacts: {
      result: ".ohostest-runs/run/result.json",
      summary: ".ohostest-runs/run/summary.md",
      commandLog: ".ohostest-runs/run/commands.jsonl",
    },
    diagnostics: [],
  };
}

test("renderCaseSummary lists comparison results by test case and classifies from metadata", () => {
  const summary = renderCaseSummary(
    baseCaseResult({
      swe: matrix([
        device("foldable", [
          suite("CommonSmokeTest", "passed", 2, 0, [
            testCase("should_launch", "passed"),
            testCase("should_keep_small", "passed"),
          ]),
          suite("MdAdaptiveSuite", "failed", 2, 1, [
            testCase("should_adapt_medium", "failed"),
            testCase("should_unknown_metadata", "passed"),
          ]),
        ]),
        device("tablet", [
          suite("LargeScreenSuite", "failed", 1, 1, [
            testCase("should_adapt_large", "failed"),
          ]),
        ]),
      ]),
      answer: matrix([
        device("foldable", [
          suite("CommonSmokeTest", "passed", 2, 0, [
            testCase("should_launch", "passed"),
            testCase("should_keep_small", "passed"),
          ]),
          suite("MdAdaptiveSuite", "passed", 2, 0, [
            testCase("should_adapt_medium", "passed"),
            testCase("should_unknown_metadata", "passed"),
          ]),
        ]),
        device("tablet", [
          suite("LargeScreenSuite", "passed", 1, 0, [
            testCase("should_adapt_large", "passed"),
          ]),
        ]),
      ]),
    }),
  );

  assert.match(summary, /### foldable\n\n#### Comparison Results/);
  assert.match(
    summary,
    /\| Suite \| Test Case \| Category \| SWE Actual \| Answer Actual \| Expected \| Verdict \|/,
  );
  assert.match(
    summary,
    /\| CommonSmokeTest \| should_launch \| pass_to_pass \| passed \| passed \| SWE pass, Answer pass \| correct \|/,
  );
  assert.match(
    summary,
    /\| MdAdaptiveSuite \| should_adapt_medium \| fail_to_pass \| failed \| passed \| SWE fail, Answer pass \| correct \|/,
  );
  assert.match(
    summary,
    /\| MdAdaptiveSuite \| should_unknown_metadata \| unclassified \| passed \| passed \| metadata category required \| incorrect \|/,
  );
  assert.doesNotMatch(summary, /##### MdAdaptiveSuite Cases/);
  assert.doesNotMatch(summary, /\| MdAdaptiveSuite \| fail_to_pass \|/);
  assert.match(summary, /\| foldable \| swe \| 4 \| 3 \| 1 \| incorrect \|/);
  assert.match(summary, /\| foldable \| answer \| 4 \| 3 \| 1 \| incorrect \|/);
  assert.match(summary, /\| tablet \| swe \| 1 \| 1 \| 0 \| correct \|/);
  assert.match(summary, /\| tablet \| answer \| 1 \| 1 \| 0 \| correct \|/);
});

test("renderCaseSummary classifies fail_to_pass from metadata instead of suite name", () => {
  const summary = renderCaseSummary(
    baseCaseResult({
      swe: matrix([
        device("foldable", [
          suite("NameContainsFailToPassButMetadataPass", "passed", 1, 0, [
            testCase("should_launch", "passed"),
          ]),
          suite("NameWithoutSpecialSuffix", "failed", 1, 1, [
            testCase("should_adapt_medium", "failed"),
          ]),
        ]),
      ]),
    }),
  );

  assert.match(summary, /### foldable\n\n#### SWE Results/);
  assert.match(
    summary,
    /\| Suite \| Test Case \| Category \| SWE Actual \| Expected \| Verdict \|/,
  );
  assert.match(
    summary,
    /\| NameContainsFailToPassButMetadataPass \| should_launch \| pass_to_pass \| passed \| SWE pass \| correct \|/,
  );
  assert.match(
    summary,
    /\| NameWithoutSpecialSuffix \| should_adapt_medium \| fail_to_pass \| failed \| SWE fail \| correct \|/,
  );
  assert.match(summary, /\| foldable \| swe \| 2 \| 2 \| 0 \| correct \|/);
});

test("renderCaseSummary marks answer-only cases against answer expectations", () => {
  const summary = renderCaseSummary(
    baseCaseResult({
      answer: matrix([
        device("foldable", [
          suite("CommonSmokeTest", "passed", 1, 0, [
            testCase("should_launch", "passed"),
          ]),
          suite("MdAdaptiveSuite", "failed", 2, 1, [
            testCase("should_adapt_medium", "passed"),
            testCase("should_adapt_large", "failed"),
          ]),
        ]),
      ]),
    }),
  );

  assert.match(summary, /### foldable\n\n#### Answer Results/);
  assert.match(
    summary,
    /\| CommonSmokeTest \| should_launch \| pass_to_pass \| passed \| Answer pass \| correct \|/,
  );
  assert.match(
    summary,
    /\| MdAdaptiveSuite \| should_adapt_medium \| fail_to_pass \| passed \| Answer pass \| correct \|/,
  );
  assert.match(
    summary,
    /\| MdAdaptiveSuite \| should_adapt_large \| fail_to_pass \| failed \| Answer pass \| incorrect \|/,
  );
  assert.match(summary, /\| foldable \| answer \| 3 \| 2 \| 1 \| incorrect \|/);
  assert.doesNotMatch(summary, /SWE Actual/);
});

test("renderCaseSummary marks conflicts and suites without parsed cases as incorrect", () => {
  const summary = renderCaseSummary(
    baseCaseResult(
      {
        swe: matrix([
          device("foldable", [
            suite("ConflictSuite", "passed", 1, 0, [
              testCase("should_be_conflicted", "passed"),
            ]),
            suite("NoParsedCasesSuite", "failed", 2, 2, []),
          ]),
        ]),
      },
      {
        testCaseTimeoutMs: 15000,
        passToPass: ["should_be_conflicted"],
        failToPass: ["should_be_conflicted"],
        deviceTestSuites: {
          foldable: [
            { suite: "ConflictSuite" },
            { suite: "NoParsedCasesSuite" },
          ],
        },
      },
    ),
  );

  assert.match(
    summary,
    /\| ConflictSuite \| should_be_conflicted \| conflict \| passed \| metadata category required \| incorrect \|/,
  );
  assert.match(
    summary,
    /\| NoParsedCasesSuite \| none parsed \| unclassified \| failed, 0\/2, failures=2 \| metadata category required \| incorrect \|/,
  );
  assert.match(summary, /\| foldable \| swe \| 2 \| 0 \| 2 \| incorrect \|/);
});

import type {
  CaseMetadata,
  CaseResult,
  CaseRunResult,
  CaseStatus,
} from "./types/index.js";
import type {
  DeviceRunResult,
  SuiteRunResult,
  TestCaseRunResult,
} from "../execution/types/index.js";

export function deriveCaseStatus(
  runs: { swe?: CaseRunResult; answer?: CaseRunResult },
  diagnostics: string[],
): CaseStatus {
  if (diagnostics.length > 0) {
    return "failed";
  }
  const executedRuns = [runs.swe, runs.answer].filter(
    (run): run is CaseRunResult => Boolean(run),
  );
  if (executedRuns.length === 0) {
    return "failed";
  }
  if (executedRuns.some((run) => run.status !== "completed")) {
    return "failed";
  }
  return "completed";
}

export function renderCaseSummary(result: CaseResult): string {
  return [
    "# ohosTest Case Summary",
    "",
    `Case: ${result.caseId}`,
    `Status: ${result.status}`,
    `Base Project: ${result.baseProject}`,
    `Command Log: ${result.artifacts.commandLog}`,
    "",
    "## Runs",
    "",
    "| Run | Status | Devices | Tests | Failures | Errors | Passes | Ignored |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    runRow("swe", result.runs.swe),
    runRow("answer", result.runs.answer),
    ...moduleRunSection(result),
    "",
    "## Device Results",
    "",
    ...deviceResultLines(result),
    "",
    "## Totals",
    "",
    "| Device | Run | Tests | Correct | Incorrect | Verdict |",
    "| --- | --- | ---: | ---: | ---: | --- |",
    ...totalsRows(result),
    "",
    "## Device Suites",
    "",
    ...deviceSuiteLines(result.metadata.deviceTestSuites),
    "",
    "## Pass To Pass",
    "",
    ...listOrEmpty(result.metadata.passToPass),
    "",
    "## Fail To Pass",
    "",
    ...listOrEmpty(result.metadata.failToPass),
    ...(result.diagnostics.length > 0
      ? ["", "## Diagnostics", "", ...listOrEmpty(result.diagnostics)]
      : []),
    "",
  ].join("\n");
}

function moduleRunSection(result: CaseResult): string[] {
  const runs = [result.runs.swe, result.runs.answer]
    .flatMap((run) => run?.module_runs ?? [])
    .map(
      (run) =>
        `| ${run.module} | ${run.devices.map((device) => device.id).join(", ")} | ${run.status} |`,
    );
  if (runs.length === 0) {
    return [];
  }
  return [
    "",
    "## Module Runs",
    "",
    "| Module | Devices | Status |",
    "| --- | --- | --- |",
    ...runs,
  ];
}

export function metadataForResult(
  metadata: CaseMetadata,
): CaseResult["metadata"] {
  return {
    testCaseTimeoutMs: metadata.testCaseTimeoutMs,
    failToPass: metadata.failToPass,
    passToPass: metadata.passToPass,
    deviceTestSuites: metadata.deviceTestSuites ?? {},
    ...(metadata.enabledDevices
      ? { enabledDevices: metadata.enabledDevices }
      : {}),
    ...(metadata.deviceHapModules
      ? { deviceHapModules: metadata.deviceHapModules }
      : {}),
  };
}

function runRow(label: string, run: CaseRunResult | undefined): string {
  if (!run) {
    return `| ${label} | not run | 0 | 0 | 0 | 0 | 0 | 0 |`;
  }
  const totals = run.devices.reduce(
    (aggregate, device) => ({
      tests: aggregate.tests + device.testsRun,
      failures: aggregate.failures + device.failures,
      errors: aggregate.errors + device.errors,
      passes: aggregate.passes + device.passes,
      ignored: aggregate.ignored + device.ignored,
    }),
    { tests: 0, failures: 0, errors: 0, passes: 0, ignored: 0 },
  );
  return [
    "|",
    label,
    "|",
    run.status,
    "|",
    String(run.devices.length),
    "|",
    String(totals.tests),
    "|",
    String(totals.failures),
    "|",
    String(totals.errors),
    "|",
    String(totals.passes),
    "|",
    String(totals.ignored),
    "|",
  ].join(" ");
}

function deviceSuiteLines(
  deviceTestSuites: CaseResult["metadata"]["deviceTestSuites"],
): string[] {
  const lines = ["| Device | Suites |", "| --- | --- |"];
  for (const [deviceId, suites] of Object.entries(deviceTestSuites)) {
    lines.push(
      `| ${deviceId} | ${suites.map((suite) => suite.suite).join(", ")} |`,
    );
  }
  return lines;
}

function listOrEmpty(values: string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ["- none"];
}

function deviceResultLines(result: CaseResult): string[] {
  return resultDeviceIds(result).flatMap((deviceId) =>
    deviceResultLinesForDevice(result, deviceId),
  );
}

function deviceResultLinesForDevice(
  result: CaseResult,
  deviceId: string,
): string[] {
  const mode = deviceResultMode(result);
  const rows = testCaseRowsForDevice(result, deviceId, mode);
  return [
    `### ${deviceId}`,
    "",
    `#### ${resultTitle(mode)}`,
    "",
    ...testCaseTableLines(rows, mode),
    "",
  ];
}

type DeviceResultMode = "swe" | "answer" | "comparison";
type RunSide = "swe" | "answer";
type TestCaseCategory =
  | "pass_to_pass"
  | "fail_to_pass"
  | "unclassified"
  | "conflict";

interface ReportTestCaseRow {
  suiteClass: string;
  testCaseName: string;
  category: TestCaseCategory;
  sweStatus?: TestCaseRunResult["status"] | SuiteRunResult["status"];
  answerStatus?: TestCaseRunResult["status"] | SuiteRunResult["status"];
  sweActual?: string;
  answerActual?: string;
}

function deviceResultMode(result: CaseResult): DeviceResultMode {
  if (result.runs.swe && result.runs.answer) {
    return "comparison";
  }
  return result.runs.swe ? "swe" : "answer";
}

function resultTitle(mode: DeviceResultMode): string {
  if (mode === "comparison") {
    return "Comparison Results";
  }
  return mode === "swe" ? "SWE Results" : "Answer Results";
}

function testCaseTableLines(
  rows: ReportTestCaseRow[],
  mode: DeviceResultMode,
): string[] {
  const body =
    rows.length > 0
      ? rows.map((row) => testCaseRow(row, mode))
      : [emptyTestCaseRow(mode)];
  return [...testCaseTableHeader(mode), ...body];
}

function testCaseTableHeader(mode: DeviceResultMode): string[] {
  if (mode === "comparison") {
    return [
      "| Suite | Test Case | Category | SWE Actual | Answer Actual | Expected | Verdict |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    ];
  }
  return [
    `| Suite | Test Case | Category | ${runLabel(mode)} Actual | Expected | Verdict |`,
    "| --- | --- | --- | --- | --- | --- |",
  ];
}

function emptyTestCaseRow(mode: DeviceResultMode): string {
  return mode === "comparison"
    ? "| none | none | unclassified | - | - | metadata category required | incorrect |"
    : "| none | none | unclassified | - | metadata category required | incorrect |";
}

function testCaseRowsForDevice(
  result: CaseResult,
  deviceId: string,
  mode: DeviceResultMode,
): ReportTestCaseRow[] {
  return suiteNamesForDevice(result, deviceId).flatMap((suiteClass) =>
    testCaseRowsForSuite(result, deviceId, suiteClass, mode),
  );
}

function testCaseRowsForSuite(
  result: CaseResult,
  deviceId: string,
  suiteClass: string,
  mode: DeviceResultMode,
): ReportTestCaseRow[] {
  const sweSuite = findSuite(result.runs.swe, deviceId, suiteClass);
  const answerSuite = findSuite(result.runs.answer, deviceId, suiteClass);
  const testCaseNames = mergedTestCaseNames(sweSuite, answerSuite, mode);
  if (testCaseNames.length === 0) {
    return [fallbackRow(suiteClass, sweSuite, answerSuite, mode)];
  }
  return testCaseNames.map((testCaseName) =>
    reportRow(result, suiteClass, testCaseName, sweSuite, answerSuite),
  );
}

function reportRow(
  result: CaseResult,
  suiteClass: string,
  testCaseName: string,
  sweSuite: SuiteRunResult | undefined,
  answerSuite: SuiteRunResult | undefined,
): ReportTestCaseRow {
  return {
    suiteClass,
    testCaseName,
    category: testCaseCategory(result.metadata, testCaseName),
    sweStatus: findTestCase(sweSuite, testCaseName)?.status,
    answerStatus: findTestCase(answerSuite, testCaseName)?.status,
  };
}

function fallbackRow(
  suiteClass: string,
  sweSuite: SuiteRunResult | undefined,
  answerSuite: SuiteRunResult | undefined,
  mode: DeviceResultMode,
): ReportTestCaseRow {
  return {
    suiteClass,
    testCaseName: "none parsed",
    category: "unclassified",
    sweStatus: mode !== "answer" ? sweSuite?.status : undefined,
    answerStatus: mode !== "swe" ? answerSuite?.status : undefined,
    sweActual: mode !== "answer" ? formatSuiteStatus(sweSuite) : undefined,
    answerActual: mode !== "swe" ? formatSuiteStatus(answerSuite) : undefined,
  };
}

function testCaseRow(row: ReportTestCaseRow, mode: DeviceResultMode): string {
  if (mode !== "comparison") {
    return singleRunTestCaseRow(row, mode);
  }
  return [
    "|",
    row.suiteClass,
    "|",
    row.testCaseName,
    "|",
    row.category,
    "|",
    row.sweActual ?? formatStatus(row.sweStatus),
    "|",
    row.answerActual ?? formatStatus(row.answerStatus),
    "|",
    expectedText(mode, row.category),
    "|",
    comparisonVerdict(row),
    "|",
  ].join(" ");
}

function singleRunTestCaseRow(
  row: ReportTestCaseRow,
  mode: Exclude<DeviceResultMode, "comparison">,
): string {
  const status = mode === "swe" ? row.sweStatus : row.answerStatus;
  const actual = mode === "swe" ? row.sweActual : row.answerActual;
  return [
    "|",
    row.suiteClass,
    "|",
    row.testCaseName,
    "|",
    row.category,
    "|",
    actual ?? formatStatus(status),
    "|",
    expectedText(mode, row.category),
    "|",
    singleRunVerdict(mode, status, row.category),
    "|",
  ].join(" ");
}

function findSuite(
  run: CaseRunResult | undefined,
  deviceId: string,
  suiteClass: string,
): SuiteRunResult | undefined {
  return findDevice(run, deviceId)?.suiteResults.find(
    (suite) => suite.suiteClass === suiteClass,
  );
}

function findTestCase(
  suite: SuiteRunResult | undefined,
  testCaseName: string,
): TestCaseRunResult | undefined {
  return suite?.testCases.find((testCase) => testCase.name === testCaseName);
}

function findDevice(
  run: CaseRunResult | undefined,
  deviceId: string,
): DeviceRunResult | undefined {
  return run?.devices.find((device) => device.id === deviceId);
}

function formatStatus(
  status: TestCaseRunResult["status"] | SuiteRunResult["status"] | undefined,
): string {
  return status ?? "missing";
}

function formatSuiteStatus(suite: SuiteRunResult | undefined): string {
  if (!suite) {
    return "missing";
  }
  const passed = Math.max(0, suite.testsRun - suite.failures - suite.errors);
  const base = `${suite.status}, ${passed}/${suite.testsRun}`;
  const details = [
    suite.failures > 0 ? `failures=${suite.failures}` : undefined,
    suite.errors > 0 ? `errors=${suite.errors}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return details.length > 0 ? `${base}, ${details.join(", ")}` : base;
}

function expectedText(
  mode: DeviceResultMode,
  category: TestCaseCategory,
): string {
  if (category === "unclassified" || category === "conflict") {
    return "metadata category required";
  }
  if (mode === "comparison") {
    return category === "pass_to_pass"
      ? "SWE pass, Answer pass"
      : "SWE fail, Answer pass";
  }
  if (mode === "answer") {
    return "Answer pass";
  }
  return category === "pass_to_pass" ? "SWE pass" : "SWE fail";
}

function runLabel(mode: Exclude<DeviceResultMode, "comparison">): string {
  return mode === "swe" ? "SWE" : "Answer";
}

function singleRunVerdict(
  mode: Exclude<DeviceResultMode, "comparison">,
  status: SuiteRunResult["status"] | TestCaseRunResult["status"] | undefined,
  category: TestCaseCategory,
): string {
  if (category === "unclassified" || category === "conflict") {
    return "incorrect";
  }
  const correct =
    mode === "answer" || category === "pass_to_pass"
      ? status === "passed"
      : status === "failed";
  return correct ? "correct" : "incorrect";
}

function comparisonVerdict(row: ReportTestCaseRow): string {
  if (row.category === "unclassified" || row.category === "conflict") {
    return "incorrect";
  }
  const swePassed = row.sweStatus === "passed";
  const answerPassed = row.answerStatus === "passed";
  const correct =
    row.category === "pass_to_pass"
      ? swePassed && answerPassed
      : row.sweStatus === "failed" && answerPassed;
  return correct ? "correct" : "incorrect";
}

function totalsRows(result: CaseResult): string[] {
  return resultDeviceIds(result).flatMap((deviceId) => {
    if (result.runs.swe && result.runs.answer) {
      return [
        totalsRow(result, deviceId, "swe"),
        totalsRow(result, deviceId, "answer"),
      ];
    }
    return result.runs.swe
      ? [totalsRow(result, deviceId, "swe")]
      : [totalsRow(result, deviceId, "answer")];
  });
}

function totalsRow(
  result: CaseResult,
  deviceId: string,
  side: RunSide,
): string {
  const rows = testCaseRowsForDevice(result, deviceId, side);
  const correct = rows.filter(
    (row) => sideVerdict(row, side) === "correct",
  ).length;
  const incorrect = rows.length - correct;
  return [
    "|",
    deviceId,
    "|",
    side,
    "|",
    String(rows.length),
    "|",
    String(correct),
    "|",
    String(incorrect),
    "|",
    incorrect === 0 ? "correct" : "incorrect",
    "|",
  ].join(" ");
}

function sideVerdict(row: ReportTestCaseRow, side: RunSide): string {
  const status = side === "swe" ? row.sweStatus : row.answerStatus;
  return singleRunVerdict(side, status, row.category);
}

function resultDeviceIds(result: CaseResult): string[] {
  return [
    ...new Set([
      ...(result.runs.swe?.devices.map((device) => device.id) ?? []),
      ...(result.runs.answer?.devices.map((device) => device.id) ?? []),
    ]),
  ];
}

function suiteNamesForDevice(result: CaseResult, deviceId: string): string[] {
  return [
    ...new Set([
      ...(findDevice(result.runs.swe, deviceId)?.suiteResults.map(
        (suite) => suite.suiteClass,
      ) ?? []),
      ...(findDevice(result.runs.answer, deviceId)?.suiteResults.map(
        (suite) => suite.suiteClass,
      ) ?? []),
    ]),
  ];
}

function mergedTestCaseNames(
  sweSuite: SuiteRunResult | undefined,
  answerSuite: SuiteRunResult | undefined,
  mode: DeviceResultMode,
): string[] {
  if (mode === "swe") {
    return sweSuite?.testCases.map((testCase) => testCase.name) ?? [];
  }
  if (mode === "answer") {
    return answerSuite?.testCases.map((testCase) => testCase.name) ?? [];
  }
  return [
    ...new Set([
      ...(sweSuite?.testCases.map((testCase) => testCase.name) ?? []),
      ...(answerSuite?.testCases.map((testCase) => testCase.name) ?? []),
    ]),
  ];
}

function testCaseCategory(
  metadata: CaseResult["metadata"],
  testCaseName: string,
): TestCaseCategory {
  const isPassToPass = metadata.passToPass.includes(testCaseName);
  const isFailToPass = metadata.failToPass.includes(testCaseName);
  if (isPassToPass && isFailToPass) {
    return "conflict";
  }
  if (isPassToPass) {
    return "pass_to_pass";
  }
  if (isFailToPass) {
    return "fail_to_pass";
  }
  return "unclassified";
}

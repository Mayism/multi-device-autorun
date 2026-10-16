import type { DeviceRunResult, ExecutionStatus } from "./types/index.js";

export function deriveExecutionStatus(
  devices: DeviceRunResult[],
): ExecutionStatus {
  if (devices.length === 0) {
    return "failed";
  }
  if (
    devices.some((device) => ["blocked", "timed_out"].includes(device.status))
  ) {
    return "failed";
  }
  return "completed";
}

export function renderSummaryMarkdown(
  status: ExecutionStatus,
  devices: DeviceRunResult[],
): string {
  return [
    "# ohosTest Matrix Summary",
    "",
    `Status: ${status}`,
    "",
    "| Device | Status | Suites | Tests | Failures | Errors | Passes | Ignored |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...devices.map(renderDeviceRow),
    "",
    ...devices.flatMap(renderDeviceSection),
  ].join("\n");
}

function renderDeviceRow(device: DeviceRunResult): string {
  return [
    "|",
    device.id,
    "|",
    device.status,
    "|",
    String(device.suiteResults.length),
    "|",
    String(device.testsRun),
    "|",
    String(device.failures),
    "|",
    String(device.errors),
    "|",
    String(device.passes),
    "|",
    String(device.ignored),
    "|",
  ].join(" ");
}

function renderDeviceSection(device: DeviceRunResult): string[] {
  const screenshots = device.screenshots ?? [];
  if (device.suiteResults.length === 0 && screenshots.length === 0) {
    return [];
  }
  return [
    `### ${device.id}`,
    "",
    ...renderFoldServerPort(device),
    ...(device.suiteResults.length > 0
      ? [
          "| Suite | Status | Tests | Failures | Errors | Passes | Ignored | Report |",
          "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
          ...device.suiteResults.map(renderSuiteRow),
          "",
          ...device.suiteResults.flatMap(renderCaseSection),
        ]
      : []),
    ...renderScreenshotLines(screenshots),
  ];
}

function renderScreenshotLines(screenshots: string[]): string[] {
  if (screenshots.length === 0) {
    return [];
  }
  return [
    `Screenshots (${screenshots.length}):`,
    "",
    ...screenshots.map((shot) => `- ${shot}`),
    "",
  ];
}

function renderFoldServerPort(device: DeviceRunResult): string[] {
  return device.foldServerPort === undefined
    ? []
    : [`- Fold Server Port: ${device.foldServerPort}`, ""];
}

function renderSuiteRow(
  suite: DeviceRunResult["suiteResults"][number],
): string {
  return [
    "|",
    suite.suiteClass,
    "|",
    suite.status,
    "|",
    String(suite.testsRun),
    "|",
    String(suite.failures),
    "|",
    String(suite.errors),
    "|",
    String(suite.passes),
    "|",
    String(suite.ignored),
    "|",
    String(suite.reportCode ?? ""),
    "|",
  ].join(" ");
}

function renderCaseSection(
  suite: DeviceRunResult["suiteResults"][number],
): string[] {
  if (suite.testCases.length === 0) {
    return [];
  }
  return [
    `#### ${suite.suiteClass}`,
    "",
    "| Test Case | Status | Code |",
    "| --- | --- | ---: |",
    ...suite.testCases.map((testCase) =>
      [
        "|",
        testCase.name,
        "|",
        testCase.status,
        "|",
        String(testCase.statusCode),
        "|",
      ].join(" "),
    ),
    "",
  ];
}

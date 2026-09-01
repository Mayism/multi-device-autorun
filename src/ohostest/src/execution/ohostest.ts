import type { ParsedAaTestOutput, TestCaseRunResult } from "./types/index.js";
import { shellQuote } from "./utils/shellQuote.js";

export interface BuildAaTestCommandInput {
  hdc: string;
  target: string;
  bundleName: string;
  testModule: string;
  testRunner: string;
  testCaseTimeoutMs?: number;
  timeoutMs: number;
  testClass?: string;
}

export const AA_TEST_CASE_TIMEOUT_MS = 15000;

export function buildAaTestCommand(input: BuildAaTestCommandInput): string {
  return [
    shellQuote(input.hdc),
    "-t",
    shellQuote(input.target),
    "shell aa test",
    "-b",
    shellQuote(input.bundleName),
    "-m",
    shellQuote(input.testModule),
    "-s unittest",
    shellQuote(input.testRunner),
    ...(input.testClass ? ["-s class", shellQuote(input.testClass)] : []),
    "-s timeout",
    String(input.testCaseTimeoutMs ?? AA_TEST_CASE_TIMEOUT_MS),
    "-w",
    String(input.timeoutMs),
  ].join(" ");
}

export function parseAaTestOutput(output: string): ParsedAaTestOutput {
  const testCases = parseTestCases(output);
  const summary =
    /Tests run:\s*(\d+),\s*Failure:\s*(\d+),\s*Error:\s*(\d+),\s*Pass:\s*(\d+),\s*Ignore:\s*(\d+)/.exec(
      output,
    );
  if (!summary) {
    return {
      ok: false,
      blockedReason: "test_output_unparseable",
      ...(testCases.length > 0 ? { testCases } : {}),
    };
  }

  const reportCodeMatch = /OHOS_REPORT_CODE:\s*(-?\d+)/.exec(output);
  const testsRun = Number(summary[1]);
  const failures = Number(summary[2]);
  const errors = Number(summary[3]);
  const passes = Number(summary[4]);
  const ignored = Number(summary[5]);
  const reportCode = reportCodeMatch ? Number(reportCodeMatch[1]) : undefined;

  return {
    ok: failures === 0 && errors === 0 && (reportCode ?? 0) === 0,
    testsRun,
    failures,
    errors,
    passes,
    ignored,
    testCases,
    ...(reportCode !== undefined ? { reportCode } : {}),
  };
}

function parseTestCases(output: string): TestCaseRunResult[] {
  const cases = new Map<string, TestCaseRunResult>();
  const records = output.split(/(?=^OHOS_REPORT_STATUS:\s+class=)/m);
  for (const record of records) {
    const name = readStatusValue(record, "test");
    const codeMatch = /^OHOS_REPORT_STATUS_CODE:\s*(-?\d+)$/m.exec(record);
    if (!name || !codeMatch) continue;
    const statusCode = Number(codeMatch[1]);
    const duration = readStatusValue(record, "consuming");
    const message = readStatusValue(record, "stream");
    const stack = readStatusValue(record, "stack");
    cases.set(name, {
      name,
      status: statusFromStatusCode(statusCode),
      statusCode,
      ...(duration && Number.isFinite(Number(duration))
        ? { durationMs: Number(duration) }
        : {}),
      ...(message ? { message } : {}),
      ...(stack ? { stack } : {}),
    });
  }
  return [...cases.values()];
}

function readStatusValue(record: string, key: string): string | undefined {
  const prefix = `OHOS_REPORT_STATUS: ${key}=`;
  const lines = record.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(prefix));
  if (start < 0) return undefined;
  const valueLines = [lines[start]?.slice(prefix.length) ?? ""];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^OHOS_REPORT_(?:STATUS|STATUS_CODE|RESULT|CODE):/.test(line)) {
      break;
    }
    valueLines.push(line);
  }
  const value = valueLines.join("\n").trim();
  return value.length > 0 ? value : undefined;
}

function statusFromStatusCode(statusCode: number): TestCaseRunResult["status"] {
  if (statusCode === 0) {
    return "passed";
  }
  if (statusCode === -3) {
    return "ignored";
  }
  if (statusCode === 1) {
    return "running";
  }
  return "failed";
}

export { shellQuote };

import type {
  CommandResult,
  SuiteRunResult,
  TestCaseRunResult,
} from "../execution/types/index.js";

export type LogPhase = "case" | "matrix" | "swe" | "answer";

export interface LogBindings {
  phase?: LogPhase;
  module?: string;
  deviceId?: string;
  suiteClass?: string;
}

export interface ErrorContext {
  errorCode?: string;
  file?: string;
  command?: string;
}

export interface CommandLogEvent extends LogBindings, CommandResult {
  event: "command";
  command: string;
}

export interface RunnerErrorEvent extends LogBindings, ErrorContext {
  event: "runner_error";
  err: Error;
}

export interface TestCaseLogEvent
  extends LogBindings, Omit<TestCaseRunResult, "name"> {
  event: "test_case";
  test: string;
}

export interface TestSuiteLogEvent
  extends
    LogBindings,
    Pick<
      SuiteRunResult,
      | "status"
      | "testsRun"
      | "failures"
      | "errors"
      | "passes"
      | "ignored"
      | "reportCode"
    > {
  event: "test_suite";
}

export function formatRunnerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!error || typeof error !== "object") return message;
  const candidate = error as { errorCode?: unknown; file?: unknown };
  const context = [
    typeof candidate.errorCode === "string" ? candidate.errorCode : undefined,
    typeof candidate.file === "string" ? candidate.file : undefined,
  ].filter((value): value is string => value !== undefined);
  return context.length > 0 ? `${context.join(": ")}: ${message}` : message;
}

import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import pino, { type Logger } from "pino";
import type {
  CommandResult,
  SuiteRunResult,
  TestCaseRunResult,
} from "../execution/types/index.js";
import type { ErrorContext, LogBindings } from "./types.js";

interface LoggerState {
  destination: ReturnType<typeof pino.destination>;
  root: Logger;
  closed: boolean;
}

export class RunnerLogger {
  private constructor(
    private readonly state: LoggerState,
    private readonly instance: Logger,
    private readonly pathValue: string,
  ) {}

  static create(logPath: string, bindings: LogBindings = {}): RunnerLogger {
    const resolvedPath = path.resolve(logPath);
    const destination = pino.destination({
      dest: resolvedPath,
      mkdir: true,
      append: false,
      sync: true,
    });
    const root = pino({ base: undefined }, destination);
    const state: LoggerState = { destination, root, closed: false };
    const instance =
      Object.keys(bindings).length > 0 ? root.child(bindings) : root;
    return new RunnerLogger(state, instance, resolvedPath);
  }

  child(bindings: LogBindings): RunnerLogger {
    return new RunnerLogger(
      this.state,
      this.instance.child(bindings),
      this.pathValue,
    );
  }

  recordCommand(command: string, result: CommandResult): void {
    const event = {
      event: "command",
      command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...nonEmptyOutput("stdout", result.stdout),
      ...nonEmptyOutput("stderr", result.stderr),
    };
    if (result.exitCode === 0) {
      this.instance.info(event);
    } else {
      this.instance.error(event);
    }
  }

  recordError(error: unknown, context: ErrorContext = {}): void {
    const err = asError(error);
    const inferred = inferErrorContext(error);
    this.instance.error({
      event: "runner_error",
      ...inferred,
      ...context,
      err,
    });
  }

  recordTestCase(result: TestCaseRunResult): void {
    const event = {
      event: "test_case",
      test: result.name,
      status: result.status,
      statusCode: result.statusCode,
      ...(result.durationMs !== undefined
        ? { durationMs: result.durationMs }
        : {}),
      ...(result.message ? { message: result.message } : {}),
      ...(result.stack ? { stack: result.stack } : {}),
    };
    if (result.status === "failed") {
      this.instance.error(event);
    } else {
      this.instance.info(event);
    }
  }

  recordTestSuite(result: SuiteRunResult): void {
    const event = {
      event: "test_suite",
      status: result.status,
      testsRun: result.testsRun,
      failures: result.failures,
      errors: result.errors,
      passes: result.passes,
      ignored: result.ignored,
      reportCode: result.reportCode,
    };
    if (result.status === "passed") {
      this.instance.info(event);
    } else {
      this.instance.error(event);
    }
  }

  get logPath(): string {
    return this.pathValue;
  }

  async close(): Promise<void> {
    if (this.state.closed) return;
    this.state.closed = true;
    this.state.destination.flushSync();
    this.state.destination.end();
  }
}

function nonEmptyOutput(
  key: "stdout" | "stderr",
  output: string,
): Partial<Record<"stdout" | "stderr", string>> {
  const stripped = stripVTControlCharacters(output);
  if (stripped.length === 0) return {};
  return { [key]: stripped };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function inferErrorContext(error: unknown): ErrorContext {
  if (!error || typeof error !== "object") return {};
  const candidate = error as {
    errorCode?: unknown;
    file?: unknown;
    command?: unknown;
  };
  return {
    ...(typeof candidate.errorCode === "string"
      ? { errorCode: candidate.errorCode }
      : {}),
    ...(typeof candidate.file === "string" ? { file: candidate.file } : {}),
    ...(typeof candidate.command === "string"
      ? { command: candidate.command }
      : {}),
  };
}

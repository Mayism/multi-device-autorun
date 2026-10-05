import { runPythonWorkerSync } from "../../../runtime/python-worker.mjs";
import type { ParsedAaTestOutput } from "./types/index.js";

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
  return JSON.parse(runPythonWorkerSync("ohostest-device-aa-command", {
    input: { ...input, platform: process.platform },
  }).toString("utf8")) as string;
}

export function parseAaTestOutput(output: string): ParsedAaTestOutput {
  return JSON.parse(runPythonWorkerSync("ohostest-device-aa-parse", {
    output,
  }).toString("utf8")) as ParsedAaTestOutput;
}

export { shellQuote } from "./utils/shellQuote.js";

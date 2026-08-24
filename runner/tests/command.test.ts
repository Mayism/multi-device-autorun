import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  decodeCommandOutput,
  defaultCommandExecutor,
  runDetachedCommand,
} from "../src/execution/command.js";
import { createLoggedCommandExecutor } from "../src/logging/command.js";
import { RunnerLogger } from "../src/logging/logger.js";
import { shellQuote } from "../src/execution/ohostest.js";

test("runDetachedCommand reports quick command failures instead of unconditional success", async () => {
  const command = `${shellQuote(process.execPath)} -e ${shellQuote("process.exit(7)")}`;

  const result = await runDetachedCommand(command, process.cwd(), 1000);

  assert.equal(result.exitCode, 7);
});

test("defaultCommandExecutor times out and terminates the spawned command tree", async () => {
  const command = `${shellQuote(process.execPath)} -e ${shellQuote("setInterval(() => {}, 1000)")}`;
  const started = Date.now();

  const result = await defaultCommandExecutor(command, process.cwd(), {
    timeoutMs: 100,
  });

  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
  assert.match(result.stderr, /command timed out after 100 ms/);
  assert.ok(Date.now() - started < 6000);
});

test("decodeCommandOutput decodes Windows GB18030 command output", () => {
  const output = decodeCommandOutput(
    Buffer.from([0xc4, 0xe3, 0xba, 0xc3]),
    "win32",
  );

  assert.equal(output, "\u4f60\u597d");
});

test("RunnerLogger writes structured commands and runner errors", async (t) => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "command-log-"));
  t.after(async () => {
    await fs.rm(outDir, { recursive: true, force: true });
  });
  const logPath = path.join(outDir, "commands.jsonl");
  const logger = RunnerLogger.create(logPath, { phase: "matrix" });
  const executor = createLoggedCommandExecutor(
    async () => ({
      stdout: "\u001b[31mfailed\u001b[0m",
      stderr: "",
      exitCode: 7,
      durationMs: 12,
    }),
    logger.child({ deviceId: "phone", suiteClass: "ExampleTest" }),
    outDir,
  );

  await executor("hdc shell aa test", outDir);
  logger.recordError(
    new Error("config_file_parse_failed: /project/build-profile.json5"),
    {
      errorCode: "CONFIG_PARSE_ERROR",
      file: "/project/build-profile.json5",
    },
  );
  await logger.close();

  const events = (await fs.readFile(logPath, "utf-8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(events.length, 2);
  assert.deepEqual(
    {
      event: events[0]?.event,
      phase: events[0]?.phase,
      deviceId: events[0]?.deviceId,
      suiteClass: events[0]?.suiteClass,
      exitCode: events[0]?.exitCode,
      stdout: events[0]?.stdout,
      stderr: events[0]?.stderr,
      level: events[0]?.level,
      pid: events[0]?.pid,
      hostname: events[0]?.hostname,
    },
    {
      event: "command",
      phase: "matrix",
      deviceId: "phone",
      suiteClass: "ExampleTest",
      exitCode: 7,
      stdout: "failed",
      stderr: undefined,
      level: 50,
      pid: undefined,
      hostname: undefined,
    },
  );
  assert.equal(events[1]?.event, "runner_error");
  assert.equal(events[1]?.errorCode, "CONFIG_PARSE_ERROR");
  assert.equal(events[1]?.file, "/project/build-profile.json5");
});

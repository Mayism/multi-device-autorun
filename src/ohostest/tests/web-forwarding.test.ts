import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { WebPortForwarding } from "../src/execution/webForwarding.js";
import { loadExecutionConfig } from "../src/execution/config.js";
import { runExecution } from "../src/execution/runner.js";
import { RunnerLogger } from "../src/logging/logger.js";
import { webFixture } from "./helpers/web-case.js";
import { commandResult, WebHdc } from "./helpers/web-hdc.js";

function forwarding(hdc: WebHdc, runCommand = hdc.run) {
  return new WebPortForwarding({
    hdc: "fake-hdc",
    target: hdc.targets[0],
    port: 5175,
    runCommand,
  });
}

async function executionFixture(t: test.TestContext) {
  const f = await webFixture(t);
  const project = path.join(f.caseDir, "base");
  const testSource = path.join(project, "entry/src/ohosTest");
  await fs.mkdir(testSource, { recursive: true });
  await fs.writeFile(
    path.join(testSource, "module.json5"),
    '{"module":{"name":"entry_test"}}',
  );
  const config = await loadExecutionConfig({
    project,
    machineConfigPath: f.machine,
  });
  return { f, config };
}

test("Web forwarding creates and verifies a targeted mapping, and cleanup is idempotent", async () => {
  const hdc = new WebHdc();
  // An identical rule on another device is not ours to borrow or remove.
  hdc.mappings.set("127.0.0.1:150010", "tcp:5175");
  const forward = forwarding(hdc);
  await forward.start();
  assert.equal(hdc.mappings.size, 2);
  await forward.stop();
  await forward.stop();
  assert.deepEqual([...hdc.mappings.keys()], ["127.0.0.1:150010"]);
  assert.deepEqual(hdc.events, [
    "add:127.0.0.1:15001",
    "remove:127.0.0.1:15001",
  ]);
  for (const command of hdc.commands)
    assert.match(command, /-t ["']?127\.0\.0\.1:15001["']? /);
});

test("Web forwarding borrows identical existing mappings, including older targetless list output", async () => {
  for (const includeTarget of [true, false]) {
    const hdc = new WebHdc();
    hdc.mappings.set(hdc.targets[0], "tcp:5175");
    const forward = forwarding(hdc, async (command) => {
      const result = await hdc.run(command);
      if (!includeTarget && command.includes("fport ls"))
        result.stdout = result.stdout.replace(`${hdc.targets[0]} `, "");
      return result;
    });
    await forward.start();
    await forward.stop();
    assert.equal(hdc.mappings.size, 1);
    assert.deepEqual(hdc.events, []);
  }
});

test("Web forwarding rejects conflicting reverse rules without replacing them", async () => {
  const hdc = new WebHdc();
  hdc.mappings.set(hdc.targets[0], "tcp:6000");
  const forward = forwarding(hdc);
  await assert.rejects(forward.start(), /web_forward_failed.*another mapping/);
  await forward.stop();
  assert.equal(hdc.mappings.get(hdc.targets[0]), "tcp:6000");
  assert.deepEqual(hdc.events, []);
});

test("A forward-direction listing is not mistaken for the required reverse mapping", async () => {
  const hdc = new WebHdc();
  const forward = forwarding(hdc, async (command) => {
    const result = await hdc.run(command);
    if (command.includes("fport ls"))
      result.stdout += `\n${hdc.targets[0]} tcp:5175 tcp:5175 [Forward]`;
    return result;
  });
  await forward.start();
  await forward.stop();
  assert.equal(hdc.events.length, 2);
});

test("HDC failure text with exit zero and listing command errors fail explicitly", async () => {
  const hdc = new WebHdc();
  hdc.rejectCreate = true;
  const forward = forwarding(hdc);
  await assert.rejects(forward.start(), /web_forward_failed.*listen failed/);
  await forward.stop();
  assert.equal(hdc.mappings.size, 0);
  const failedList = forwarding(hdc, async () =>
    commandResult("device unavailable", 1),
  );
  await assert.rejects(
    failedList.start(),
    /web_forward_failed.*device unavailable/,
  );
});

test("A verification exception after creation still allows owned mapping cleanup", async () => {
  const hdc = new WebHdc();
  let lists = 0;
  const forward = forwarding(hdc, async (command) => {
    if (command.includes("fport ls") && ++lists === 2)
      throw new Error("list interrupted");
    return hdc.run(command);
  });
  await assert.rejects(forward.start(), /web_forward_failed.*list interrupted/);
  assert.equal(hdc.mappings.size, 1);
  await forward.stop();
  assert.equal(hdc.mappings.size, 0);
});

test("Cleanup preserves a changed rule and detects a remove command that leaves the rule behind", async () => {
  for (const changed of [true, false]) {
    const hdc = new WebHdc();
    const forward = forwarding(hdc);
    await forward.start();
    if (changed) hdc.mappings.set(hdc.targets[0], "tcp:6000");
    else hdc.retainOnRemove = true;
    await assert.rejects(forward.stop(), /web_forward_cleanup_failed/);
    assert.equal(hdc.mappings.size, 1);
    if (changed) assert.equal(hdc.events.length, 1);
  }
});

test("Web forwarding follows three ready devices and multiple suites serially, including kept emulators", async (t) => {
  const { f, config } = await executionFixture(t);
  const hdc = new WebHdc([
    "127.0.0.1:15001",
    "127.0.0.1:15002",
    "127.0.0.1:15003",
  ]);
  const devices = hdc.targets.map((target, index) => ({
    ...config.devices[0],
    id: ["phone", "foldable", "tablet"][index],
    target,
    testClasses: ["FirstSuite", "SecondSuite"],
  }));
  const logger = RunnerLogger.create(path.join(f.out, "commands.jsonl"));
  try {
    const result = await runExecution({
      config: { ...config, devices },
      plan: { devices },
      outDir: f.out,
      skipBuild: true,
      keepEmulators: true,
      webServerPort: 5175,
      logger,
      commandExecutor: async (command) => {
        if (command.includes(" rport ")) {
          assert.equal(
            hdc.mappings.size,
            0,
            "previous device mapping must be gone",
          );
          assert.ok(
            [...hdc.commands]
              .reverse()
              .find(
                (item) => item.includes("keyEvent") || item.includes(" rport "),
              )
              ?.includes("keyEvent"),
            "device must be prepared first",
          );
        }
        if (command.includes("aa test") || command.includes(" install "))
          assert.equal(hdc.mappings.size, 1);
        return hdc.run(command);
      },
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(
      result.devices.map((device) => device.testsRun),
      [2, 2, 2],
    );
    assert.deepEqual(
      hdc.events,
      hdc.targets.flatMap((target) => [
        `add:${target}`,
        `test:${target}`,
        `test:${target}`,
        `remove:${target}`,
      ]),
    );
    assert.equal(hdc.mappings.size, 0);
  } finally {
    await logger.close();
  }
});

test("Forwarding setup, native failures and cleanup failures are reported without leaking owned mappings or dropping tests", async (t) => {
  for (const failure of ["setup", "install", "test", "cleanup"] as const) {
    await t.test(failure, async (t) => {
      const { f, config } = await executionFixture(t);
      const hdc = new WebHdc();
      hdc.rejectCreate = failure === "setup";
      hdc.retainOnRemove = failure === "cleanup";
      const logPath = path.join(f.out, "commands.jsonl");
      const logger = RunnerLogger.create(logPath);
      try {
        const result = await runExecution({
          config,
          plan: { devices: config.devices },
          outDir: f.out,
          skipBuild: true,
          webServerPort: 5175,
          logger,
          commandExecutor: async (command) => {
            const result = await hdc.run(command);
            if (failure === "install" && command.includes(" install "))
              return commandResult("install failed", 1);
            if (failure === "test" && command.includes("aa test"))
              return commandResult("test crashed", 1);
            return result;
          },
        });
        const reason = {
          setup: "web_forward_failed",
          install: "install_failed",
          test: "test_command_failed",
          cleanup: "web_forward_cleanup_failed",
        }[failure];
        assert.equal(result.status, "failed");
        assert.equal(result.devices[0]?.blockedReason, reason);
        assert.equal(hdc.mappings.size, failure === "cleanup" ? 1 : 0);
        if (failure === "setup")
          assert.ok(
            !hdc.commands.some(
              (command) =>
                command.includes(" install ") || command.includes("aa test"),
            ),
          );
        if (failure === "cleanup") assert.equal(result.devices[0]?.testsRun, 1);
      } finally {
        await logger.close();
      }
      if (failure === "setup" || failure === "cleanup")
        assert.match(await fs.readFile(logPath, "utf8"), /WEB_FORWARD/);
    });
  }
});

test("Execution without a Web service does not issue forwarding commands", async (t) => {
  const { f, config } = await executionFixture(t);
  const hdc = new WebHdc();
  const logger = RunnerLogger.create(path.join(f.out, "commands.jsonl"));
  try {
    const result = await runExecution({
      config,
      plan: { devices: config.devices },
      outDir: f.out,
      skipBuild: true,
      logger,
      commandExecutor: hdc.run,
    });
    assert.equal(result.status, "completed");
    assert.ok(!hdc.commands.some((command) => /rport|fport/.test(command)));
  } finally {
    await logger.close();
  }
});

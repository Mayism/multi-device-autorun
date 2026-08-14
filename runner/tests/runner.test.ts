import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runOhosTestMatrix } from "../src/matrix/runner.js";
import { isRetriableTestLaunchResult } from "../src/execution/runner.js";
import * as executionRunner from "../src/execution/runner.js";
import type { DeviceRunResult } from "../src/execution/types/index.js";
import {
  readFoldServerState,
  removeFoldServerState,
} from "../src/fold/server.js";

async function makeProject(
  t: test.TestContext,
  options: { withSharedModule?: boolean } = {},
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohostest-runner-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, "hvigorw"), "#!/bin/sh\n", "utf-8");
  await fs.mkdir(path.join(root, "AppScope"), { recursive: true });
  await fs.writeFile(
    path.join(root, "AppScope", "app.json5"),
    JSON.stringify({ app: { bundleName: "zhsc.1.xxxxxx" } }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(root, "build-profile.json5"),
    JSON.stringify({
      app: { products: [{ name: "default" }] },
      modules: [
        { name: "entry", srcPath: "./products/entry" },
        ...(options.withSharedModule
          ? [{ name: "common", srcPath: "./commons/common" }]
          : []),
      ],
    }),
    "utf-8",
  );
  await fs.mkdir(path.join(root, "products", "entry", "src", "main"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(root, "products", "entry", "hvigorfile.ts"),
    "import { hapTasks } from '@ohos/hvigor-ohos-plugin';\nexport default { system: hapTasks, plugins: [] };\n",
    "utf-8",
  );
  await fs.writeFile(
    path.join(root, "products", "entry", "src", "main", "module.json5"),
    JSON.stringify({ module: { name: "entry", type: "entry" } }),
    "utf-8",
  );
  if (options.withSharedModule) {
    await fs.mkdir(path.join(root, "commons", "common", "src", "main"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, "commons", "common", "src", "main", "module.json5"),
      JSON.stringify({ module: { name: "common", type: "shared" } }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(root, "commons", "common", "oh-package.json5"),
      JSON.stringify({ name: "common", dependencies: {} }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(root, "commons", "common", "hvigorfile.ts"),
      "import { hspTasks } from '@ohos/hvigor-ohos-plugin';\nexport default { system: hspTasks, plugins: [] };\n",
      "utf-8",
    );
    const commonOutput = path.join(
      root,
      "commons/common/build/default/outputs/default",
    );
    await fs.mkdir(commonOutput, { recursive: true });
    await fs.writeFile(
      path.join(commonOutput, "common-default-unsigned.hsp"),
      "",
      "utf-8",
    );
  }
  await fs.mkdir(path.join(root, "products", "entry", "src", "ohosTest"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(root, "products", "entry", "src", "ohosTest", "module.json5"),
    JSON.stringify({ module: { name: "entry_test" } }),
    "utf-8",
  );
  await fs.mkdir(path.join(root, "entry/build/default/outputs/default"), {
    recursive: true,
  });
  await fs.mkdir(path.join(root, "entry/build/default/outputs/ohosTest"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(
      root,
      "entry/build/default/outputs/default/entry-default-unsigned.hap",
    ),
    "",
    "utf-8",
  );
  await fs.writeFile(
    path.join(
      root,
      "entry/build/default/outputs/ohosTest/entry-ohosTest-unsigned.hap",
    ),
    "",
    "utf-8",
  );
  return root;
}

async function makeMachineConfig(
  project: string,
  options: {
    foldServerScript?: string;
    hdc?: string;
    devices?: Array<Record<string, unknown>>;
  } = {},
): Promise<string> {
  const machineConfigPath = path.join(project, "machine.json");
  await fs.writeFile(
    machineConfigPath,
    JSON.stringify({
      paths: {
        hdc: options.hdc ?? "/fake/hdc",
        hvigorw: "/fake/hvigorw",
        ohpm: "/fake/ohpm",
        emulatorBin: "/fake/Emulator",
        emulatorDeployedDir: "/fake/deployed",
        ...(options.foldServerScript
          ? { foldServerScript: options.foldServerScript }
          : {}),
      },
      devices: options.devices ?? [
          {
            id: "phone",
            target: "127.0.0.1:15001",
            profile: "Mate 80 Pro",
            hdcPort: 15001,
            ...(options.foldServerScript ? { foldControl: true } : {}),
          },
        ],
    }),
    "utf-8",
  );
  return machineConfigPath;
}

test("fold cleanup failure blocks the device without discarding test results", () => {
  const applyCleanupFailure = (
    executionRunner as unknown as {
      applyFoldCleanupFailure?: (
        result: DeviceRunResult,
      ) => DeviceRunResult;
    }
  ).applyFoldCleanupFailure;
  assert.equal(typeof applyCleanupFailure, "function");
  const result: DeviceRunResult = {
    id: "foldable",
    target: "127.0.0.1:15003",
    status: "passed",
    testsRun: 3,
    failures: 0,
    errors: 0,
    passes: 3,
    ignored: 0,
    suiteResults: [
      {
        suiteClass: "FoldControlTest",
        status: "passed",
        testsRun: 3,
        failures: 0,
        errors: 0,
        passes: 3,
        ignored: 0,
        reportCode: 0,
        ok: true,
        testCases: [],
      },
    ],
    durationMs: 10,
    log: "commands.jsonl",
    foldServerPort: 8766,
  };

  assert.deepEqual(applyCleanupFailure!(result), {
    ...result,
    status: "blocked",
    blockedReason: "fold_cleanup_failed",
  });
});

test("runOhosTestMatrix builds, installs, runs tests, and writes artifacts", async (t) => {
  const project = await makeProject(t, { withSharedModule: true });
  const machineConfigPath = await makeMachineConfig(project);
  const out = path.join(project, ".ohostest-runs/latest/result.json");
  await fs.mkdir(
    path.join(project, "products/entry/build/default/outputs/default"),
    { recursive: true },
  );
  await fs.mkdir(
    path.join(project, "products/entry/build/default/outputs/ohosTest"),
    { recursive: true },
  );
  await fs.writeFile(
    path.join(
      project,
      "products/entry/build/default/outputs/default/entry-default-unsigned.hap",
    ),
    "",
    "utf-8",
  );
  await fs.writeFile(
    path.join(
      project,
      "products/entry/build/default/outputs/ohosTest/entry-ohosTest-unsigned.hap",
    ),
    "",
    "utf-8",
  );
  const commands: string[] = [];

  const result = await runOhosTestMatrix({
    project,
    machineConfigPath,
    out,
    commandExecutor: async (command) => {
      commands.push(command);
      if (command.includes("aa test")) {
        return {
          stdout:
            "OHOS_REPORT_RESULT: stream=Tests run: 25, Failure: 0, Error: 0, Pass: 25, Ignore: 0\nOHOS_REPORT_CODE: 0\n",
          stderr: "",
          exitCode: 0,
          durationMs: 10,
        };
      }
      return {
        stdout: command.includes("list targets")
          ? "127.0.0.1:15001\tConnected\n"
          : "",
        stderr: "",
        exitCode: 0,
        durationMs: 5,
      };
    },
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(
    result.devices.map((item) => item.status),
    ["passed"],
  );
  assert.ok(commands.some((command) => command.includes("aa test")));
  assert.ok(await fs.readFile(out, "utf-8"));
  assert.match(
    await fs.readFile(path.join(path.dirname(out), "summary.md"), "utf-8"),
    /Status: completed/,
  );
  assert.equal(result.artifacts.commandLog, "commands.jsonl");
  assert.equal(result.devices[0]?.log, "commands.jsonl");
  const logEvents = (
    await fs.readFile(path.join(path.dirname(out), "commands.jsonl"), "utf-8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(logEvents.every((event) => event.phase === "matrix"));
  assert.ok(
    logEvents.some(
      (event) =>
        event.deviceId === "phone" &&
        event.suiteClass === "ALL" &&
        String(event.command).includes("aa test"),
    ),
  );
  assert.equal(
    logEvents.filter((event) => String(event.command).includes("list targets"))
      .length,
    1,
  );
});

test("runOhosTestMatrix manages forwarding around a fold-enabled device run", async (t) => {
  const project = await makeProject(t);
  await prepareRunnerArtifacts(project);
  const machineConfigPath = await makeMachineConfig(project, {
    foldServerScript: path.resolve("src/fold/assets/fold-server.py"),
    hdc: "/fake/hdc-runner-managed",
  });
  const out = path.join(project, ".ohostest-runs/fold/result.json");
  const commands: string[] = [];

  const commandExecutor = async (command: string) => {
    commands.push(command);
    if (command.includes("list targets")) {
      return commandResult("127.0.0.1:15001\tConnected\n");
    }
    if (command.includes(" rport ") || command.includes(" fport rm ")) {
      return commandResult("OK");
    }
    if (command.endsWith("fport ls")) {
      return commandResult("[Empty]");
    }
    if (command.includes("aa test")) {
      return commandResult(
        "OHOS_REPORT_RESULT: stream=Tests run: 1, Failure: 0, Error: 0, Pass: 1, Ignore: 0\nOHOS_REPORT_CODE: 0\n",
      );
    }
    return commandResult("");
  };
  const result = await runOhosTestMatrix({
    project,
    machineConfigPath,
    out,
    commandExecutor,
  });
  const repeated = await runOhosTestMatrix({
    project,
    machineConfigPath,
    out: path.join(project, ".ohostest-runs/fold-repeat/result.json"),
    commandExecutor,
  });

  assert.equal(result.devices[0]?.status, "passed");
  assert.equal(repeated.devices[0]?.status, "passed");
  const addIndex = commands.findIndex((command) => command.includes(" rport "));
  const testIndex = commands.findIndex((command) => command.includes("aa test"));
  const removeIndex = commands.findIndex(
    (command, index) => index > testIndex && command.includes(" fport rm "),
  );
  assert.ok(addIndex >= 0 && addIndex < testIndex);
  assert.ok(removeIndex > testIndex);
  assert.equal(commands.filter((command) => command.includes(" rport ")).length, 2);
  assert.equal(commands.filter((command) => command.includes(" fport rm ")).length, 2);
});

test("runOhosTestMatrix releases one fold device before starting the next", async (t) => {
  const project = await makeProject(t);
  await prepareRunnerArtifacts(project);
  const hdc = "/fake/hdc-runner-multi-fold";
  const targets = ["127.0.0.1:15001", "127.0.0.1:15002"];
  const machineConfigPath = await makeMachineConfig(project, {
    foldServerScript: path.resolve("src/fold/assets/fold-server.py"),
    hdc,
    devices: targets.map((target, index) => ({
      id: `fold-${index + 1}`,
      target,
      profile: `Mate X${index + 7}`,
      hdcPort: 15001 + index,
      foldControl: true,
    })),
  });
  const commands: string[] = [];
  t.after(async () => {
    for (const target of targets) {
      const stored = await readFoldServerState(hdc, target);
      if (!stored) continue;
      try {
        process.kill(stored.state.pid, "SIGTERM");
      } catch {
        // The runner may already have stopped it.
      }
      await removeFoldServerState(stored.stateFile);
    }
  });

  const result = await runOhosTestMatrix({
    project,
    machineConfigPath,
    out: path.join(project, ".ohostest-runs/fold-multi/result.json"),
    commandExecutor: async (command) => {
      commands.push(command);
      if (command.includes("list targets")) {
        return commandResult(targets.map((target) => `${target}\tConnected`).join("\n"));
      }
      if (command.includes(" rport ") || command.includes(" fport rm ")) {
        return commandResult("OK");
      }
      if (command.endsWith("fport ls")) return commandResult("[Empty]");
      if (command.includes("aa test")) {
        return commandResult(
          "OHOS_REPORT_RESULT: stream=Tests run: 1, Failure: 0, Error: 0, Pass: 1, Ignore: 0\nOHOS_REPORT_CODE: 0\n",
        );
      }
      return commandResult("");
    },
  });

  assert.deepEqual(result.devices.map((device) => device.status), ["passed", "passed"]);
  const firstTest = commands.findIndex(
    (command) => command.includes(`-t ${targets[0]}`) && command.includes("aa test"),
  );
  const firstRemove = commands.findIndex(
    (command) => command.includes(`-t ${targets[0]}`) && command.includes(" fport rm "),
  );
  const secondAdd = commands.findIndex(
    (command) => command.includes(`-t ${targets[1]}`) && command.includes(" rport "),
  );
  assert.ok(firstTest >= 0 && firstRemove > firstTest && secondAdd > firstRemove);
});

test("runOhosTestMatrix cleans fold resources when trigger deployment throws", async (t) => {
  const project = await makeProject(t);
  await prepareRunnerArtifacts(project);
  const machineConfigPath = await makeMachineConfig(project, {
    foldServerScript: path.resolve("src/fold/assets/fold-server.py"),
    hdc: "/fake/hdc-runner-deploy-error",
  });
  const commands: string[] = [];
  t.after(async () => {
    const stored = await readFoldServerState(
      "/fake/hdc-runner-deploy-error",
      "127.0.0.1:15001",
    );
    if (!stored) return;
    try {
      process.kill(stored.state.pid, "SIGTERM");
    } catch {
      // The runner may already have stopped it.
    }
    await removeFoldServerState(stored.stateFile);
  });

  await runOhosTestMatrix({
    project,
    machineConfigPath,
    out: path.join(project, ".ohostest-runs/fold-error/result.json"),
    commandExecutor: async (command) => {
      commands.push(command);
      if (command.includes("list targets")) {
        return commandResult("127.0.0.1:15001\tConnected\n");
      }
      if (command.includes(" rport ") || command.includes(" fport rm ")) {
        return commandResult("OK");
      }
      if (command.endsWith("fport ls")) {
        return commandResult("[Empty]");
      }
      if (command.includes("@ohosTest") && !command.includes("--stacktrace")) {
        throw new Error("test hap rebuild failed");
      }
      return commandResult("");
    },
  });

  assert.ok(commands.some((command) => command.includes(" rport ")));
  assert.ok(commands.some((command) => command.includes(" fport rm ")));
});

test("runOhosTestMatrix preserves test counts when fold cleanup remains blocked", async (t) => {
  const project = await makeProject(t);
  await prepareRunnerArtifacts(project);
  const machineConfigPath = await makeMachineConfig(project, {
    foldServerScript: path.resolve("src/fold/assets/fold-server.py"),
    hdc: "/fake/hdc-runner-cleanup-error",
  });
  t.after(async () => {
    const stored = await readFoldServerState(
      "/fake/hdc-runner-cleanup-error",
      "127.0.0.1:15001",
    );
    if (stored) await removeFoldServerState(stored.stateFile);
  });
  const occupiedTasks = Array.from(
    { length: 100 },
    (_value, offset) => `tcp:${8765 + offset} tcp:${8766 + offset}`,
  ).join("\n");

  const result = await runOhosTestMatrix({
    project,
    machineConfigPath,
    out: path.join(project, ".ohostest-runs/fold-cleanup/result.json"),
    commandExecutor: async (command) => {
      if (command.includes("list targets")) {
        return commandResult("127.0.0.1:15001\tConnected\n");
      }
      if (command.includes(" rport ") || command.includes(" fport rm ")) {
        return commandResult("OK");
      }
      if (command.endsWith("fport ls")) {
        return commandResult(occupiedTasks);
      }
      if (command.includes("aa test")) {
        return commandResult(
          "OHOS_REPORT_RESULT: stream=Tests run: 1, Failure: 0, Error: 0, Pass: 1, Ignore: 0\nOHOS_REPORT_CODE: 0\n",
        );
      }
      return commandResult("");
    },
  });

  assert.equal(result.devices[0]?.status, "blocked");
  assert.equal(result.devices[0]?.blockedReason, "fold_cleanup_failed");
  assert.equal(result.devices[0]?.testsRun, 1);
  assert.equal(result.devices[0]?.passes, 1);
});

async function prepareRunnerArtifacts(project: string): Promise<void> {
  const appOutput = path.join(
    project,
    "products/entry/build/default/outputs/default",
  );
  const testOutput = path.join(
    project,
    "products/entry/build/default/outputs/ohosTest",
  );
  await fs.mkdir(appOutput, { recursive: true });
  await fs.mkdir(testOutput, { recursive: true });
  await fs.writeFile(path.join(appOutput, "entry-default-unsigned.hap"), "");
  await fs.writeFile(
    path.join(testOutput, "entry-ohosTest-unsigned.hap"),
    "",
  );
}

function commandResult(stdout: string) {
  return { stdout, stderr: "", exitCode: 0, durationMs: 1 };
}

test("runOhosTestMatrix wakes and retries once when aa test reports a locked screen", async (t) => {
  const project = await makeProject(t);
  const machineConfigPath = path.join(project, "pc-machine.json");
  await fs.writeFile(
    machineConfigPath,
    JSON.stringify({
      paths: {
        hdc: "/fake/hdc",
        hvigorw: "/fake/hvigorw",
        ohpm: "/fake/ohpm",
        emulatorBin: "/fake/Emulator",
        emulatorDeployedDir: "/fake/deployed",
      },
      devices: [
        {
          id: "pc",
          target: "127.0.0.1:15005",
          profile: "MateBook Pro",
          hdcPort: 15005,
          testSuites: ["PcAdaptiveTest"],
        },
      ],
    }),
    "utf-8",
  );
  await fs.mkdir(
    path.join(project, "products/entry/build/default/outputs/default"),
    { recursive: true },
  );
  await fs.mkdir(
    path.join(project, "products/entry/build/default/outputs/ohosTest"),
    { recursive: true },
  );
  await fs.writeFile(
    path.join(
      project,
      "products/entry/build/default/outputs/default/entry-default-unsigned.hap",
    ),
    "",
    "utf-8",
  );
  await fs.writeFile(
    path.join(
      project,
      "products/entry/build/default/outputs/ohosTest/entry-ohosTest-unsigned.hap",
    ),
    "",
    "utf-8",
  );

  const commands: string[] = [];
  let aaTestCount = 0;
  const result = await runOhosTestMatrix({
    project,
    machineConfigPath,
    out: path.join(project, "result.json"),
    commandExecutor: async (command) => {
      commands.push(command);
      if (command.includes("aa test")) {
        aaTestCount += 1;
        return aaTestCount === 1
          ? {
              stdout:
                "Error Code:10106102 Error Message:The device screen is locked during the application launch, unlock screen failed.\nTestFinished-ResultCode: -3\n",
              stderr: "",
              exitCode: 0,
              durationMs: 1,
            }
          : {
              stdout:
                "OHOS_REPORT_RESULT: stream=Tests run: 1, Failure: 0, Error: 0, Pass: 1, Ignore: 0\nOHOS_REPORT_CODE: 0\n",
              stderr: "",
              exitCode: 0,
              durationMs: 1,
            };
      }
      if (command.includes("list targets")) {
        return {
          stdout: "127.0.0.1:15005\tConnected\n",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        };
      }
      if (command.includes("const.product.devicetype")) {
        return {
          stdout: "2in1\n",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
    },
  });

  assert.equal(result.devices[0]?.status, "passed");
  assert.equal(aaTestCount, 2);
  assert.equal(
    commands.filter((command) => command.includes("power-shell wakeup")).length,
    2,
  );
});

test("isRetriableTestLaunchResult recognizes transient ability launch failures", () => {
  const result = (stdout: string) => ({
    stdout,
    stderr: "",
    exitCode: 0,
    durationMs: 1,
  });

  assert.equal(
    isRetriableTestLaunchResult(
      result("TestFinished-ResultMsg: TestAbility onDestroy unexpectedly!"),
    ),
    true,
  );
  assert.equal(
    isRetriableTestLaunchResult(result("Can not connect to AAMS")),
    true,
  );
  assert.equal(
    isRetriableTestLaunchResult(
      result("OHOS_REPORT_RESULT: stream=Tests run: 1, Pass: 1"),
    ),
    false,
  );
});

test("runOhosTestMatrix persists structured configuration failures", async (t) => {
  const project = await makeProject(t);
  const machineConfigPath = path.join(project, "invalid-machine.json");
  const out = path.join(project, "config-error", "result.json");
  await fs.writeFile(machineConfigPath, "{ invalid", "utf-8");

  const result = await runOhosTestMatrix({
    project,
    machineConfigPath,
    out,
  });

  assert.equal(result.status, "failed");
  assert.match(result.diagnostics[0] ?? "", /config_file_parse_failed/);
  assert.match(await fs.readFile(out, "utf-8"), /config_file_parse_failed/);
  const events = (
    await fs.readFile(path.join(path.dirname(out), "commands.jsonl"), "utf-8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(events[0]?.event, "runner_error");
  assert.equal(events[0]?.errorCode, "CONFIG_PARSE_ERROR");
  assert.equal(events[0]?.file, path.resolve(machineConfigPath));
});

test("runOhosTestMatrix blocks install output errors before aa test", async (t) => {
  const project = await makeProject(t, { withSharedModule: true });
  const machineConfigPath = await makeMachineConfig(project);
  const out = path.join(project, "install-error/result.json");
  await fs.mkdir(
    path.join(project, "products/entry/build/default/outputs/default"),
    { recursive: true },
  );
  await fs.mkdir(
    path.join(project, "products/entry/build/default/outputs/ohosTest"),
    { recursive: true },
  );
  await fs.writeFile(
    path.join(
      project,
      "products/entry/build/default/outputs/default/entry-default-unsigned.hap",
    ),
    "",
    "utf-8",
  );
  await fs.writeFile(
    path.join(
      project,
      "products/entry/build/default/outputs/ohosTest/entry-ohosTest-unsigned.hap",
    ),
    "",
    "utf-8",
  );
  const commands: string[] = [];

  const result = await runOhosTestMatrix({
    project,
    machineConfigPath,
    out,
    commandExecutor: async (command) => {
      commands.push(command);
      if (command.includes(" install -r ")) {
        return {
          stdout:
            "[Info]App install path:entry.hap msg:error: failed to install bundle. code:9568305 error: Failed to install the HAP or HSP because the dependent module does not exist. entry's dependent module: common does not exist",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        };
      }
      return {
        stdout: command.includes("list targets")
          ? "127.0.0.1:15001\tConnected\n"
          : "",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      };
    },
  });

  assert.equal(result.devices[0]?.status, "blocked");
  assert.equal(result.devices[0]?.blockedReason, "install_failed");
  assert.equal(
    commands.some((command) => command.includes("aa test")),
    false,
  );
});

test("runOhosTestMatrix waits five seconds after stopping one emulator before starting the next", async (t) => {
  const project = await makeProject(t);
  const fakeEmulator = path.join(project, "FakeEmulator.sh");
  await fs.writeFile(fakeEmulator, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const machineConfigPath = path.join(project, "serial-emulators.json");
  await fs.writeFile(
    machineConfigPath,
    JSON.stringify({
      paths: {
        hdc: "/fake/hdc",
        hvigorw: "/fake/hvigorw",
        emulatorBin: fakeEmulator,
        emulatorDeployedDir: "/fake/deployed",
      },
      devices: [
        {
          id: "phone",
          target: "127.0.0.1:15001",
          profile: "Mate 80 Pro",
          hdcPort: 15001,
          startEmulator: true,
        },
        {
          id: "tablet",
          target: "127.0.0.1:15003",
          profile: "MatePad Pro 13",
          hdcPort: 15003,
          startEmulator: true,
        },
      ],
    }),
    "utf-8",
  );
  await fs.mkdir(
    path.join(project, "products/entry/build/default/outputs/default"),
    { recursive: true },
  );
  await fs.mkdir(
    path.join(project, "products/entry/build/default/outputs/ohosTest"),
    { recursive: true },
  );
  await fs.writeFile(
    path.join(
      project,
      "products/entry/build/default/outputs/default/entry-default-unsigned.hap",
    ),
    "",
    "utf-8",
  );
  await fs.writeFile(
    path.join(
      project,
      "products/entry/build/default/outputs/ohosTest/entry-ohosTest-unsigned.hap",
    ),
    "",
    "utf-8",
  );

  let aaTestCount = 0;
  let returnedDisconnectedAfterFirstStop = false;
  const result = await runOhosTestMatrix({
    project,
    machineConfigPath,
    out: path.join(project, "result.json"),
    commandExecutor: async (command) => {
      if (command.includes("aa test")) {
        aaTestCount += 1;
      }
      let listTargetsOutput = "";
      if (command.includes("list targets")) {
        if (aaTestCount === 0) {
          listTargetsOutput = "127.0.0.1:15001\tConnected\n";
        } else if (!returnedDisconnectedAfterFirstStop) {
          returnedDisconnectedAfterFirstStop = true;
        } else if (aaTestCount < 2) {
          listTargetsOutput = "127.0.0.1:15003\tConnected\n";
        }
      }
      return {
        stdout: command.includes("aa test")
          ? "OHOS_REPORT_RESULT: stream=Tests run: 1, Failure: 0, Error: 0, Pass: 1, Ignore: 0\nOHOS_REPORT_CODE: 0\n"
          : listTargetsOutput,
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      };
    },
  });

  assert.equal(result.devices.length, 2);
  assert.ok(result.durationMs >= 5000);
});

test("runOhosTestMatrix times out one aa test command and continues with the next device", async (t) => {
  const project = await makeProject(t);
  const machineConfigPath = path.join(project, "timeout-continues.json");
  await fs.writeFile(
    machineConfigPath,
    JSON.stringify({
      timeoutMs: 120000,
      paths: {
        hdc: "/fake/hdc",
        hvigorw: "/fake/hvigorw",
        ohpm: "/fake/ohpm",
        emulatorBin: "/fake/Emulator",
        emulatorDeployedDir: "/fake/deployed",
      },
      devices: [
        {
          id: "foldable",
          target: "127.0.0.1:15005",
          profile: "Mate X7",
          startEmulator: false,
        },
        {
          id: "tablet",
          target: "127.0.0.1:15003",
          profile: "MatePad Pro 13",
          startEmulator: false,
        },
      ],
    }),
    "utf-8",
  );
  await fs.mkdir(
    path.join(project, "products/entry/build/default/outputs/default"),
    { recursive: true },
  );
  await fs.mkdir(
    path.join(project, "products/entry/build/default/outputs/ohosTest"),
    { recursive: true },
  );
  await fs.writeFile(
    path.join(
      project,
      "products/entry/build/default/outputs/default/entry-default-unsigned.hap",
    ),
    "",
  );
  await fs.writeFile(
    path.join(
      project,
      "products/entry/build/default/outputs/ohosTest/entry-ohosTest-unsigned.hap",
    ),
    "",
  );

  const aaTargets: string[] = [];
  const hostTimeouts: Array<number | undefined> = [];
  const result = await runOhosTestMatrix({
    project,
    machineConfigPath,
    out: path.join(project, "timeout-result.json"),
    commandExecutor: async (command, _cwd, options) => {
      if (command.includes("aa test")) {
        aaTargets.push(
          command.includes("127.0.0.1:15005") ? "foldable" : "tablet",
        );
        hostTimeouts.push(options?.timeoutMs);
        if (command.includes("127.0.0.1:15005")) {
          return {
            stdout: "",
            stderr: "host watchdog expired",
            exitCode: 124,
            durationMs: 150000,
            timedOut: true,
          };
        }
        return {
          stdout:
            "OHOS_REPORT_RESULT: stream=Tests run: 1, Failure: 0, Error: 0, Pass: 1, Ignore: 0\nOHOS_REPORT_CODE: 0\n",
          stderr: "",
          exitCode: 0,
          durationMs: 10,
        };
      }
      if (command.includes("list targets")) {
        return {
          stdout: "127.0.0.1:15005\tConnected\n127.0.0.1:15003\tConnected\n",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        };
      }
      if (command.includes("ScreenlockService")) {
        return {
          stdout: "screenLocked false\n",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
    },
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(aaTargets, ["foldable", "tablet"]);
  assert.deepEqual(hostTimeouts, [150000, 150000]);
  assert.deepEqual(
    result.devices.map((device) => [device.id, device.status]),
    [
      ["foldable", "timed_out"],
      ["tablet", "passed"],
    ],
  );
});

test("runOhosTestMatrix runs configured test suites separately and aggregates results", async (t) => {
  const project = await makeProject(t);
  const machineConfigPath = path.join(project, "suites.json");
  await fs.writeFile(
    machineConfigPath,
    JSON.stringify({
      paths: {
        hdc: "/fake/hdc",
        hvigorw: "/fake/hvigorw",
        emulatorBin: "/fake/Emulator",
        emulatorDeployedDir: "/fake/deployed",
      },
      devices: [
        {
          id: "foldable",
          target: "127.0.0.1:15002",
          profile: "Mate X7",
          hdcPort: 15002,
          testSuites: [
            "CommonPassToPassTest",
            "SmPassToPassTest",
            "MdFailToPassTest",
          ],
        },
      ],
    }),
    "utf-8",
  );
  await fs.mkdir(
    path.join(project, "products/entry/build/default/outputs/default"),
    { recursive: true },
  );
  await fs.mkdir(
    path.join(project, "products/entry/build/default/outputs/ohosTest"),
    { recursive: true },
  );
  await fs.writeFile(
    path.join(
      project,
      "products/entry/build/default/outputs/default/entry-default-unsigned.hap",
    ),
    "",
    "utf-8",
  );
  await fs.writeFile(
    path.join(
      project,
      "products/entry/build/default/outputs/ohosTest/entry-ohosTest-unsigned.hap",
    ),
    "",
    "utf-8",
  );
  const commands: string[] = [];

  const result = await runOhosTestMatrix({
    project,
    machineConfigPath,
    out: path.join(project, "result.json"),
    commandExecutor: async (command) => {
      commands.push(command);
      if (command.includes("CommonPassToPassTest")) {
        return {
          stdout:
            "OHOS_REPORT_RESULT: stream=Tests run: 10, Failure: 0, Error: 0, Pass: 10, Ignore: 0\nOHOS_REPORT_CODE: 0\n",
          stderr: "",
          exitCode: 0,
          durationMs: 10,
        };
      }
      if (command.includes("SmPassToPassTest")) {
        return {
          stdout:
            "OHOS_REPORT_RESULT: stream=Tests run: 6, Failure: 0, Error: 0, Pass: 5, Ignore: 1\nOHOS_REPORT_CODE: 0\n",
          stderr: "",
          exitCode: 0,
          durationMs: 10,
        };
      }
      if (command.includes("MdFailToPassTest")) {
        return {
          stdout: [
            "OHOS_REPORT_STATUS: class=MdFailToPassTest",
            "OHOS_REPORT_STATUS: current=1",
            "OHOS_REPORT_STATUS: stack=    at AssertException @ohos/hypium (service.js:23:9)",
            "    at should_adapt_medium (MdFailToPass.test.ets:42:7)",
            "OHOS_REPORT_STATUS: stream=Error in should_adapt_medium, expect true, actualValue is false",
            "OHOS_REPORT_STATUS: test=should_adapt_medium",
            "OHOS_REPORT_STATUS_CODE: -2",
            "OHOS_REPORT_STATUS: consuming=239",
            "OHOS_REPORT_RESULT: stream=Tests run: 5, Failure: 2, Error: 0, Pass: 3, Ignore: 0",
            "OHOS_REPORT_CODE: 1",
            "",
          ].join("\n"),
          stderr: "",
          exitCode: 0,
          durationMs: 10,
        };
      }
      return {
        stdout: command.includes("list targets")
          ? "127.0.0.1:15002\tConnected\n"
          : "",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      };
    },
  });

  const aaCommands = commands.filter((command) => command.includes("aa test"));
  assert.deepEqual(
    aaCommands.map((command) => /-s class ([A-Za-z0-9_]+)/.exec(command)?.[1]),
    ["CommonPassToPassTest", "SmPassToPassTest", "MdFailToPassTest"],
  );
  assert.equal(result.devices[0]?.status, "failed");
  assert.equal(result.devices[0]?.testsRun, 21);
  assert.equal(result.devices[0]?.failures, 2);
  assert.equal(result.devices[0]?.passes, 18);
  assert.equal(result.devices[0]?.ignored, 1);
  assert.deepEqual(result.devices[0]?.suiteResults[2]?.testCases[0], {
    name: "should_adapt_medium",
    status: "failed",
    statusCode: -2,
    durationMs: 239,
    message: "Error in should_adapt_medium, expect true, actualValue is false",
    stack:
      "at AssertException @ohos/hypium (service.js:23:9)\n    at should_adapt_medium (MdFailToPass.test.ets:42:7)",
  });
  assert.deepEqual(
    result.devices[0]?.suiteResults.map((suite) => [
      suite.suiteClass,
      suite.status,
      suite.testsRun,
      suite.reportCode,
    ]),
    [
      ["CommonPassToPassTest", "passed", 10, 0],
      ["SmPassToPassTest", "passed", 6, 0],
      ["MdFailToPassTest", "failed", 5, 1],
    ],
  );
  const events = (
    await fs.readFile(path.join(project, "commands.jsonl"), "utf-8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const failedTest = events.find(
    (event) =>
      event.event === "test_case" && event.test === "should_adapt_medium",
  );
  assert.equal(failedTest?.level, 50);
  assert.match(String(failedTest?.message), /actualValue is false/);
  assert.match(String(failedTest?.stack), /MdFailToPass\.test\.ets:42/);
  const testCommand = events.find(
    (event) =>
      event.event === "command" &&
      String(event.command).includes("MdFailToPassTest"),
  );
  assert.equal(testCommand?.stdout, undefined);
});

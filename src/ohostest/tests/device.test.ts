import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildHideEmulatorCommand,
  buildStartEmulatorCommand,
  ensureTargetReady,
  installHaps,
  isEmulatorProcessListed,
  isInstallFailure,
  parseScreenLocked,
  prepareDevice,
  waitForTargetDisconnected,
} from "../src/execution/device.js";
import type {
  DeviceConfig,
  InstallArtifacts,
  MatrixConfig,
} from "../src/matrix/types/index.js";
import { RunnerLogger } from "../src/logging/logger.js";

function makeConfig(): MatrixConfig {
  return {
    project: "D:\\Projects\\ResponsiveRepeatLayout",
    product: "default",
    module: "entry",
    moduleSrcPath: "entry",
    sharedModules: [],
    bundleName: "zhsc.1.xxxxxx",
    testModule: "entry_test",
    testRunner: "OpenHarmonyTestRunner",
    testCaseTimeoutMs: 15000,
    timeoutMs: 120000,
    build: {
      mode: "project",
      appTask: "assembleApp",
      testTask: "ohosTest@PackageHap",
    },
    paths: {
      hvigorw: "hvigorw",
      ohpm: "ohpm",
      hdc: "hdc",
      emulatorBin: "D:\\Software\\Deveco Studio\\tools\\emulator\\Emulator.exe",
      emulatorDeployedDir: "D:\\Software\\Deveco Studio\\emulator\\deployed",
    },
    artifacts: {
      appHap:
        "D:\\Projects\\ResponsiveRepeatLayout\\entry-default-unsigned.hap",
      testHap:
        "D:\\Projects\\ResponsiveRepeatLayout\\entry-ohosTest-unsigned.hap",
    },
    devices: [],
  };
}

test("prepareDevice selects the unlock key from the runtime device type", async (t) => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void) => {
    callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
  });
  const cases = [
    {
      name: "uses Enter for a 2in1 PC",
      probe: {
        stdout: "2in1\n",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      },
      expectedKey: "2054",
    },
    {
      name: "keeps Home for a phone",
      probe: {
        stdout: "phone\n",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      },
      expectedKey: "Home",
    },
    {
      name: "falls back to Home when the probe fails",
      probe: {
        stdout: "",
        stderr: "unsupported parameter",
        exitCode: 1,
        durationMs: 1,
      },
      expectedKey: "Home",
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const config = makeConfig();
      const device: DeviceConfig = {
        id: "arbitrary-user-id",
        target: "127.0.0.1:15004",
        startEmulator: true,
      };
      const commands: string[] = [];

      await prepareDevice({
        config,
        device,
        cwd: config.project,
        outDir: "out",
        runCommand: async (command) => {
          commands.push(command);
          if (command === "hdc list targets") {
            return {
              stdout: "127.0.0.1:15004\tConnected\n",
              stderr: "",
              exitCode: 0,
              durationMs: 1,
            };
          }
          if (command.endsWith("param get const.product.devicetype")) {
            return testCase.probe;
          }
          if (command.includes("ScreenlockService")) {
            return {
              stdout: "screenLocked false\n",
              stderr: "",
              exitCode: 0,
              durationMs: 1,
            };
          }
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
            durationMs: 1,
          };
        },
      });

      assert.deepEqual(commands, [
        "hdc list targets",
        "hdc -t 127.0.0.1:15004 shell param get const.product.devicetype",
        "hdc -t 127.0.0.1:15004 shell power-shell wakeup",
        `hdc -t 127.0.0.1:15004 shell uitest uiInput keyEvent ${testCase.expectedKey}`,
        "hdc -t 127.0.0.1:15004 shell hidumper -s ScreenlockService -a -all",
      ]);
    });
  }
});

test("prepareDevice retries a locked phone with the unlock key and verifies success", async (t) => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void) => {
    callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
  });
  const config = makeConfig();
  const device: DeviceConfig = {
    id: "foldable",
    target: "127.0.0.1:15005",
    startEmulator: true,
  };
  const commands: string[] = [];
  let lockProbes = 0;

  await prepareDevice({
    config,
    device,
    cwd: config.project,
    outDir: "out",
    runCommand: async (command) => {
      commands.push(command);
      if (command === "hdc list targets") {
        return result("127.0.0.1:15005\tConnected\n");
      }
      if (command.endsWith("param get const.product.devicetype")) {
        return result("phone\n");
      }
      if (command.includes("ScreenlockService")) {
        lockProbes += 1;
        return result(`screenLocked ${lockProbes === 1 ? "true" : "false"}\n`);
      }
      return result("");
    },
  });

  assert.equal(lockProbes, 2);
  assert.deepEqual(
    commands.filter((command) => command.includes("keyEvent")),
    [
      "hdc -t 127.0.0.1:15005 shell uitest uiInput keyEvent Home",
      "hdc -t 127.0.0.1:15005 shell uitest uiInput keyEvent 2054",
    ],
  );
});

test("prepareDevice rejects a device that remains screen locked", async (t) => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void) => {
    callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
  });
  const config = makeConfig();
  const device: DeviceConfig = {
    id: "foldable",
    target: "127.0.0.1:15005",
    startEmulator: true,
  };

  await assert.rejects(
    prepareDevice({
      config,
      device,
      cwd: config.project,
      outDir: "out",
      runCommand: async (command) => {
        if (command === "hdc list targets") {
          return result("127.0.0.1:15005\tConnected\n");
        }
        if (command.endsWith("param get const.product.devicetype")) {
          return result("phone\n");
        }
        if (command.includes("ScreenlockService")) {
          return result("screenLocked true\n");
        }
        return result("");
      },
    }),
    /device_unlock_failed/,
  );
});

test("parseScreenLocked handles hidumper output and unsupported probes", () => {
  assert.equal(parseScreenLocked(result("screenLocked true\n")), true);
  assert.equal(parseScreenLocked(result("screenLocked: false\n")), false);
  assert.equal(parseScreenLocked(result("service unavailable\n")), undefined);
  assert.equal(
    parseScreenLocked({ stdout: "", stderr: "unsupported", exitCode: 1 }),
    undefined,
  );
});

function result(stdout: string): {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
} {
  return { stdout, stderr: "", exitCode: 0, durationMs: 1 };
}

test("installHaps ignores uninstall failure and uninstalls the bundle before installing HAPs", async () => {
  const config = makeConfig();
  config.artifacts = {
    appHap: "/tmp/app.hap",
    testHap: "/tmp/test.hap",
  };
  const device: DeviceConfig = {
    id: "phone",
    target: "127.0.0.1:15001",
    startEmulator: false,
  };
  const commands: string[] = [];

  await installHaps(
    {
      config,
      device,
      cwd: config.project,
      outDir: "out",
      runCommand: async (command) => {
        commands.push(command);
        return {
          stdout: "",
          stderr: command.includes(" uninstall ") ? "bundle not found" : "",
          exitCode: command.includes(" uninstall ") ? 1 : 0,
          durationMs: 1,
        };
      },
    },
    {
      hspPaths: [],
      appHap: "/tmp/app.hap",
      testHap: "/tmp/test.hap",
    },
  );

  assert.deepEqual(commands, [
    "hdc -t 127.0.0.1:15001 uninstall zhsc.1.xxxxxx",
    "hdc -t 127.0.0.1:15001 install -r /tmp/app.hap /tmp/test.hap",
  ]);
});

test("installHaps installs HSPs before the app and test HAPs", async () => {
  const config = makeConfig();
  const device: DeviceConfig = {
    id: "phone",
    target: "127.0.0.1:15001",
    startEmulator: false,
  };
  const artifacts: InstallArtifacts = {
    hspPaths: ["/tmp/common.hsp", "/tmp/styles.hsp"],
    appHap: "/tmp/app.hap",
    testHap: "/tmp/test.hap",
  };
  const commands: string[] = [];

  await installHaps(
    {
      config,
      device,
      cwd: config.project,
      outDir: "out",
      runCommand: async (command) => {
        commands.push(command);
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        };
      },
    },
    artifacts,
  );

  assert.deepEqual(commands, [
    "hdc -t 127.0.0.1:15001 uninstall zhsc.1.xxxxxx",
    "hdc -t 127.0.0.1:15001 install -r /tmp/common.hsp",
    "hdc -t 127.0.0.1:15001 install -r /tmp/styles.hsp",
    "hdc -t 127.0.0.1:15001 install -r /tmp/app.hap /tmp/test.hap",
  ]);
});

test("installHaps removes stale isolated bundles but keeps the active bundle", async () => {
  const config = makeConfig();
  config.bundleNameCleanup = {
    prefixes: ["zhsc.1."],
    keep: ["zhsc.1.keep"],
  };
  const commands: string[] = [];
  await installHaps({
    config,
    device: { id: "phone", target: "127.0.0.1:15001", startEmulator: false },
    cwd: config.project,
    outDir: "out",
    runCommand: async (command) => {
      commands.push(command);
      return result(command.includes("bm dump -a")
        ? "zhsc.1.old\nzhsc.1.keep\nzhsc.1.old\nother.bundle\n"
        : "");
    },
  }, { hspPaths: [], appHap: "/tmp/app.hap", testHap: "/tmp/test.hap" });
  assert.deepEqual(commands, [
    "hdc -t 127.0.0.1:15001 uninstall zhsc.1.xxxxxx",
    "hdc -t 127.0.0.1:15001 shell bm dump -a",
    "hdc -t 127.0.0.1:15001 uninstall zhsc.1.old",
    "hdc -t 127.0.0.1:15001 install -r /tmp/app.hap /tmp/test.hap",
  ]);
});

test("installHaps rejects AppMod install errors even when hdc exits zero", async () => {
  const config = makeConfig();
  const device: DeviceConfig = {
    id: "phone",
    target: "127.0.0.1:15001",
    startEmulator: false,
  };
  const artifacts: InstallArtifacts = {
    hspPaths: ["/tmp/common.hsp"],
    appHap: "/tmp/app.hap",
    testHap: "/tmp/test.hap",
  };
  const commands: string[] = [];

  await assert.rejects(
    installHaps(
      {
        config,
        device,
        cwd: config.project,
        outDir: "out",
        runCommand: async (command) => {
          commands.push(command);
          return {
            stdout: command.includes(" install ")
              ? "[Info]App install path:/tmp/app.hap msg:error: failed to install bundle. code:9568305 error: Failed to install the HAP or HSP because the dependent module does not exist. entry's dependent module: common does not exist"
              : "",
            stderr: "",
            exitCode: 0,
            durationMs: 1,
          };
        },
      },
      artifacts,
    ),
    /install_failed/,
  );
  assert.deepEqual(commands, [
    "hdc -t 127.0.0.1:15001 uninstall zhsc.1.xxxxxx",
    "hdc -t 127.0.0.1:15001 install -r /tmp/common.hsp",
  ]);
});

test("isInstallFailure checks stderr and preserves normal zero-exit output", () => {
  assert.equal(
    isInstallFailure({
      stdout: "",
      stderr: "error: failed to install bundle",
      exitCode: 0,
      durationMs: 1,
    }),
    true,
  );
  assert.equal(
    isInstallFailure({
      stdout: "AppMod finish",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    }),
    false,
  );
});

test("buildStartEmulatorCommand quotes Windows profile and instance path with double quotes", () => {
  const device: DeviceConfig = {
    id: "phone",
    profile: "Mate 80 Pro",
    target: "127.0.0.1:15001",
    hdcPort: 15001,
    startEmulator: true,
  };

  const command = buildStartEmulatorCommand(makeConfig(), device, "win32");

  assert.equal(
    command,
    'start "" /min "D:\\Software\\Deveco Studio\\tools\\emulator\\Emulator.exe" -start "Mate 80 Pro" -instancePath "D:\\Software\\Deveco Studio\\emulator\\deployed" -bootMode coldboot -hdcport 15001',
  );
});

test("buildStartEmulatorCommand allows an explicit snapshot boot override", () => {
  const device: DeviceConfig = {
    id: "phone",
    profile: "Mate 80 Pro",
    target: "127.0.0.1:15001",
    hdcPort: 15001,
    bootMode: "snapshot",
    startEmulator: true,
  };

  const command = buildStartEmulatorCommand(makeConfig(), device, "win32");

  assert.match(command, / -bootMode snapshot -hdcport 15001$/);
});

test("buildStartEmulatorCommand keeps non-Windows commands unwrapped", () => {
  const device: DeviceConfig = {
    id: "phone",
    profile: "Mate 80 Pro",
    target: "127.0.0.1:15001",
    hdcPort: 15001,
    startEmulator: true,
  };

  const command = buildStartEmulatorCommand(makeConfig(), device, "darwin");

  assert.doesNotMatch(command, /^start /);
  assert.match(command, /^'D:\\Software\\Deveco Studio\\tools\\emulator\\Emulator\.exe' -start /);
});

test("buildHideEmulatorCommand dispatches per platform", () => {
  assert.match(
    buildHideEmulatorCommand("win32"),
    /^powershell -NoProfile -ExecutionPolicy Bypass -File ".*hide-emulator-windows\.ps1"$/,
  );
  assert.match(
    buildHideEmulatorCommand("darwin"),
    /^osascript -e 'tell application "System Events" to set visible of every process whose name is "Emulator" to false'$/,
  );
  assert.equal(buildHideEmulatorCommand("linux"), "");
});

test("isEmulatorProcessListed matches Emulator rows per platform output", () => {
  const csv = [
    '"notepad.exe","123","Console","1","10,000 K"',
    '"Emulator.exe","33560","Console","1","2,670,392 K"',
    '"emulator-crash-service.exe","40584","Console","1","23,776 K"',
  ].join("\r\n");
  assert.equal(isEmulatorProcessListed(csv, "win32"), true);
  assert.equal(isEmulatorProcessListed('"notepad.exe","123"', "win32"), false);
  assert.equal(
    isEmulatorProcessListed('"emulator-crash-service.exe","40584"', "win32"),
    false,
  );
  assert.equal(isEmulatorProcessListed("", "win32"), false);
  assert.equal(isEmulatorProcessListed("501 Emulator\n502 Emulator", "darwin"), true);
  assert.equal(isEmulatorProcessListed("501 loginwindow", "darwin"), false);
  assert.equal(isEmulatorProcessListed("501 Emulator", "linux"), false);
});

test("buildStartEmulatorCommand wraps macOS .app bundles with open -j", () => {
  const config = makeConfig();
  config.paths.emulatorBin =
    "/Applications/DevEco Studio.app/Contents/tools/emulator/Emulator.app";
  const device: DeviceConfig = {
    id: "phone",
    profile: "Mate 80 Pro",
    target: "127.0.0.1:15001",
    hdcPort: 15001,
    startEmulator: true,
  };

  const command = buildStartEmulatorCommand(config, device, "darwin");

  assert.match(command, /^open -j -a '.*Emulator\.app' --args -start /);
});

test("ensureTargetReady waits up to 120 polling attempts for slow Windows emulator startup", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void) => {
    callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    let attempts = 0;
    const config = makeConfig();
    const device: DeviceConfig = {
      id: "phone",
      target: "127.0.0.1:15001",
      startEmulator: true,
    };

    await ensureTargetReady({
      config,
      device,
      cwd: config.project,
      outDir: "out",
      runCommand: async (command: string) => {
        if (!command.includes("list targets")) {
          // 模拟器窗口隐藏等辅助命令
          return { stdout: "0", stderr: "", exitCode: 0, durationMs: 1 };
        }
        attempts += 1;
        return {
          stdout:
            attempts === 120 ? "127.0.0.1:15001\tConnected\n" : "[Empty]\n",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        };
      },
    });

    assert.equal(attempts, 120);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("ensureTargetReady logs only the final polling result", async (t) => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void) => {
    callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "device-poll-log-"));
  t.after(async () => {
    globalThis.setTimeout = originalSetTimeout;
    await fs.rm(outDir, { recursive: true, force: true });
  });
  const logger = RunnerLogger.create(path.join(outDir, "commands.jsonl"), {
    phase: "matrix",
    deviceId: "phone",
  });
  let attempts = 0;
  const config = makeConfig();
  const device: DeviceConfig = {
    id: "phone",
    target: "127.0.0.1:15001",
    startEmulator: true,
  };

  await ensureTargetReady({
    config,
    device,
    cwd: config.project,
    outDir,
    runCommand: async () => {
      throw new Error("polling must use the raw executor");
    },
    pollCommand: async (command: string) => {
      if (!command.includes("list targets")) {
        return { stdout: "0", stderr: "", exitCode: 0, durationMs: 0 };
      }
      attempts += 1;
      return {
        stdout: attempts === 3 ? "127.0.0.1:15001\tConnected\n" : "[Empty]\n",
        stderr: "",
        exitCode: 0,
        durationMs: attempts,
      };
    },
    logger,
  });
  await logger.close();

  const events = (await fs.readFile(logger.logPath, "utf-8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(attempts, 3);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.durationMs, 3);
});

test("waitForTargetDisconnected waits before allowing the next emulator to start", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void) => {
    callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    let attempts = 0;
    const config = makeConfig();
    const device: DeviceConfig = {
      id: "phone",
      target: "127.0.0.1:15001",
      startEmulator: true,
    };

    const disconnected = await waitForTargetDisconnected({
      config,
      device,
      cwd: config.project,
      outDir: "out",
      runCommand: async () => {
        attempts += 1;
        return {
          stdout: attempts < 3 ? "127.0.0.1:15001\tConnected\n" : "[Empty]\n",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        };
      },
    });

    assert.equal(disconnected, true);
    assert.equal(attempts, 3);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

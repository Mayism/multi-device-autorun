import { describe, it } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { foldTriggerTemplate } from "../src/fold/foldTriggerTemplate.js";
import { deployFoldTrigger, healthCheck } from "../src/fold/server.js";
import * as foldServer from "../src/fold/server.js";
import * as foldPorts from "../src/fold/utils/ports.js";

describe("foldTriggerTemplate", () => {
  it("embeds devicePort in the generated template", () => {
    const template = foldTriggerTemplate(8765);
    assert.ok(template.includes("const FOLD_SERVER_PORT = 8765"));
  });

  it("contains no placeholder after injection", () => {
    const template = foldTriggerTemplate(8765);
    assert.ok(!template.includes("__FOLD_PORT__"));
  });

  it("different ports produce different templates", () => {
    const t1 = foldTriggerTemplate(8765);
    const t2 = foldTriggerTemplate(8766);
    assert.notStrictEqual(t1, t2);
  });
});

describe("deployFoldTrigger", () => {
  it("creates FoldTrigger.ets in a temp project directory", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fold-test-"));
    try {
      const entryDir = path.join(
        tmp,
        "entry",
        "src",
        "ohosTest",
        "ets",
        "util",
      );
      const deployed = await deployFoldTrigger(tmp, 8765, "entry");
      const expected = path.join(entryDir, "FoldTrigger.ets");
      assert.strictEqual(deployed, expected);
      const content = await fs.readFile(expected, "utf-8");
      assert.ok(content.includes("const FOLD_SERVER_PORT = 8765"));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("overwrites when FoldTrigger.ets already exists", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fold-test-"));
    try {
      const entryDir = path.join(
        tmp,
        "entry",
        "src",
        "ohosTest",
        "ets",
        "util",
      );
      await fs.mkdir(entryDir, { recursive: true });
      const existing = path.join(entryDir, "FoldTrigger.ets");
      await fs.writeFile(existing, "// old content", "utf-8");

      const deployed = await deployFoldTrigger(tmp, 9999, "entry");
      assert.strictEqual(deployed, existing);
      const content = await fs.readFile(existing, "utf-8");
      assert.ok(content.includes("const FOLD_SERVER_PORT = 9999"));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("healthCheck", () => {
  it("returns false when no server is running on the port", async () => {
    const result = await healthCheck(65432, 1000);
    assert.strictEqual(result, false);
  });

  it("rejects a healthy server owned by another runner", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok", ownerToken: "old-runner" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try {
      const result = await healthCheck(address.port, 200, "new-runner");
      assert.strictEqual(result, false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe("fold server port allocation", () => {
  it("skips occupied host ports and keeps the paired device port", async () => {
    const findAvailable = (
      foldPorts as unknown as {
        findAvailableFoldServerPort?: (
          isAvailable: (port: number) => Promise<boolean>,
        ) => Promise<{ port: number; devicePort: number }>;
      }
    ).findAvailableFoldServerPort;
    assert.equal(typeof findAvailable, "function");
    const checked: number[] = [];

    const allocated = await findAvailable!(async (port) => {
      checked.push(port);
      return port === 8768;
    });

    assert.deepEqual(checked, [8766, 8767, 8768]);
    assert.deepEqual(allocated, { port: 8768, devicePort: 8767 });
  });
});

describe("fold forwarding commands", () => {
  it("quotes Windows hdc paths and preserves the selected target", () => {
    const builders = foldServer as unknown as {
      buildReversePortCommand?: (
        hdc: string,
        target: string,
        devicePort: number,
        port: number,
        platform: NodeJS.Platform,
      ) => string;
      buildRemoveReversePortCommand?: (
        hdc: string,
        target: string,
        devicePort: number,
        port: number,
        platform: NodeJS.Platform,
      ) => string;
    };
    assert.equal(typeof builders.buildReversePortCommand, "function");
    assert.equal(typeof builders.buildRemoveReversePortCommand, "function");

    assert.equal(
      builders.buildReversePortCommand!(
        "D:\\DevEco Studio\\hdc.exe",
        "127.0.0.1:15003",
        8765,
        8766,
        "win32",
      ),
      '"D:\\DevEco Studio\\hdc.exe" -t 127.0.0.1:15003 rport tcp:8765 tcp:8766',
    );
    assert.equal(
      builders.buildRemoveReversePortCommand!(
        "D:\\DevEco Studio\\hdc.exe",
        "127.0.0.1:15003",
        8765,
        8766,
        "win32",
      ),
      '"D:\\DevEco Studio\\hdc.exe" -t 127.0.0.1:15003 fport rm tcp:8765 tcp:8766',
    );
  });
});

describe("fold server state", () => {
  it("writes and reads target-scoped state atomically", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fold-state-test-"));
    const state = {
      schemaVersion: 1 as const,
      pid: 4321,
      port: 8766,
      devicePort: 8765,
      target: "127.0.0.1:15003",
      ownerToken: "runner-token",
      forwardTask: "tcp:8765 tcp:8766",
      createdAt: "2026-08-11T00:00:00.000Z",
    };
    type TestState = typeof state;
    const api = foldServer as unknown as {
      writeFoldServerState?: (
        state: TestState,
        hdc: string,
        stateRoot: string,
      ) => Promise<string>;
      readFoldServerState?: (
        hdc: string,
        target: string,
        stateRoot: string,
      ) => Promise<{ state: TestState; stateFile: string } | undefined>;
    };
    assert.equal(typeof api.writeFoldServerState, "function");
    assert.equal(typeof api.readFoldServerState, "function");

    try {
      const stateFile = await api.writeFoldServerState!(
        state,
        "D:\\DevEco Studio\\hdc.exe",
        stateRoot,
      );
      const restored = await api.readFoldServerState!(
        "D:\\DevEco Studio\\hdc.exe",
        state.target,
        stateRoot,
      );

      assert.deepEqual(restored, { state, stateFile });
      assert.deepEqual(await fs.readdir(stateRoot), [path.basename(stateFile)]);
    } finally {
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("rejects a stored non-positive pid before recovery can signal it", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fold-state-pid-test-"));
    const stateFile = await foldServer.writeFoldServerState(
      {
        schemaVersion: 1,
        pid: -1,
        port: 8766,
        devicePort: 8765,
        target: "127.0.0.1:15003",
        ownerToken: "invalid-pid-owner",
        forwardTask: "tcp:8765 tcp:8766",
        createdAt: "2026-08-11T00:00:00.000Z",
      },
      "hdc",
      stateRoot,
    );

    try {
      await assert.rejects(
        foldServer.readFoldServerState(
          "hdc",
          "127.0.0.1:15003",
          stateRoot,
        ),
        /fold_state_invalid/,
      );
    } finally {
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("managed fold server lifecycle", () => {
  it("rolls back a failed reverse port and retries the next port pair", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fold-managed-test-"));
    const children = [fakeChildProcess(4101), fakeChildProcess(4102)];
    const commands: string[] = [];
    const spawnedCommands: string[] = [];
    const api = foldServer as unknown as {
      startManagedFoldServer?: (input: {
        device: {
          id: string;
          profile: string;
          target: string;
          startEmulator: boolean;
          foldControl: boolean;
        };
        foldServerScript: string;
        hdc: string;
        runCommand: (command: string) => Promise<{
          stdout: string;
          stderr: string;
          exitCode: number;
          durationMs: number;
        }>;
        stateRoot: string;
        runtime: {
          spawnProcess: (command: string) => ChildProcess;
          checkHealth: () => Promise<boolean>;
          isPortAvailable: () => Promise<boolean>;
          ownerToken: () => string;
          platform: NodeJS.Platform;
        };
      }) => Promise<{
        port: number;
        devicePort: number;
        process: ChildProcess;
        stateFile: string;
      }>;
    };
    assert.equal(typeof api.startManagedFoldServer, "function");

    try {
      let spawnIndex = 0;
      const instance = await api.startManagedFoldServer!({
        device: {
          id: "foldable",
          profile: "Mate X7",
          target: "127.0.0.1:15003",
          startEmulator: true,
          foldControl: true,
        },
        foldServerScript: "fold-server.py",
        hdc: "hdc",
        runCommand: async (command) => {
          commands.push(command);
          const firstPair = command.includes("rport tcp:8765 tcp:8766");
          return {
            stdout: firstPair ? "[Fail] port exists" : "OK",
            stderr: "",
            exitCode: firstPair ? 1 : 0,
            durationMs: 1,
          };
        },
        stateRoot,
        runtime: {
          spawnProcess: (command) => {
            spawnedCommands.push(command);
            return children[spawnIndex++]!;
          },
          checkHealth: async () => true,
          isPortAvailable: async () => true,
          ownerToken: () => `token-${spawnIndex}`,
          platform: "win32",
        },
      });

      assert.equal(instance.port, 8767);
      assert.equal(instance.devicePort, 8766);
      assert.equal(children[0]!.killed, true);
      assert.ok(commands.some((command) => command.includes("rport tcp:8765 tcp:8766")));
      assert.ok(commands.some((command) => command.includes("rport tcp:8766 tcp:8767")));
      assert.deepEqual(spawnedCommands, ["python", "python"]);
      assert.equal(path.dirname(instance.stateFile), stateRoot);
    } finally {
      for (const child of children) child.kill();
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("rolls back and retries when the reverse-port command throws", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fold-rport-throw-test-"));
    const children = [fakeChildProcess(4151), fakeChildProcess(4152)];
    let spawnIndex = 0;
    let rportAttempts = 0;

    try {
      const instance = await foldServer.startManagedFoldServer({
        device: {
          id: "foldable",
          profile: "Mate X7",
          target: "127.0.0.1:15003",
          startEmulator: true,
          foldControl: true,
        },
        foldServerScript: "fold-server.py",
        hdc: "hdc",
        runCommand: async (command) => {
          if (command.includes(" rport ")) {
            rportAttempts += 1;
            if (rportAttempts === 1) throw new Error("hdc disconnected");
          }
          return {
            stdout: "OK",
            stderr: "",
            exitCode: 0,
            durationMs: 1,
          };
        },
        stateRoot,
        runtime: {
          spawnProcess: () => children[spawnIndex++]!,
          checkHealth: async () => true,
          isPortAvailable: async () => true,
          ownerToken: () => `throw-owner-${spawnIndex}`,
        },
      });

      assert.equal(instance.port, 8767);
      assert.equal(children[0]!.killed, true);
      assert.equal(rportAttempts, 2);
    } finally {
      for (const child of children) child.kill();
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("stops the child when writing recovery state fails", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fold-state-write-test-"));
    const stateRoot = path.join(temporaryRoot, "state");
    await fs.mkdir(stateRoot);
    const child = fakeChildProcess(4171);

    try {
      await assert.rejects(
        foldServer.startManagedFoldServer({
          device: {
            id: "foldable",
            profile: "Mate X7",
            target: "127.0.0.1:15003",
            startEmulator: true,
            foldControl: true,
          },
          foldServerScript: "fold-server.py",
          hdc: "hdc",
          runCommand: async () => ({
            stdout: "OK",
            stderr: "",
            exitCode: 0,
            durationMs: 1,
          }),
          stateRoot,
          runtime: {
            spawnProcess: () => {
              fsSync.rmSync(stateRoot, { recursive: true });
              fsSync.writeFileSync(stateRoot, "blocked", "utf-8");
              return child;
            },
            checkHealth: async () => true,
            isPortAvailable: async () => true,
          },
        }),
      );
      assert.equal(child.killed, true);
    } finally {
      child.kill();
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("handles an asynchronous spawn error without leaving it unobserved", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fold-spawn-error-test-"));
    const child = fakeChildProcess(4191);
    Object.defineProperty(child, "pid", { value: undefined });

    try {
      await assert.rejects(
        foldServer.startManagedFoldServer({
          device: {
            id: "foldable",
            profile: "Mate X7",
            target: "127.0.0.1:15003",
            startEmulator: true,
            foldControl: true,
          },
          foldServerScript: "fold-server.py",
          hdc: "hdc",
          runCommand: async () => ({
            stdout: "OK",
            stderr: "",
            exitCode: 0,
            durationMs: 1,
          }),
          stateRoot,
          runtime: {
            spawnProcess: () => child,
            isPortAvailable: async () => true,
          },
        }),
        /fold_server_start_failed/,
      );

      assert.ok(child.listenerCount("error") > 0);
      assert.doesNotThrow(() => child.emit("error", new Error("spawn python ENOENT")));
    } finally {
      child.kill();
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("retries the next pair when the selected host port is taken before bind", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fold-bind-race-test-"));
    const occupiedChild = fakeChildProcess(4192);
    Object.defineProperty(occupiedChild, "exitCode", { value: 1, writable: true });
    (occupiedChild.stderr as PassThrough).end(
      "OSError: [Errno 48] Address already in use",
    );
    const healthyChild = fakeChildProcess(4193);
    const children = [occupiedChild, healthyChild];
    let spawnIndex = 0;
    const availability = [true, false, true];

    try {
      const instance = await foldServer.startManagedFoldServer({
        device: {
          id: "foldable",
          profile: "Mate X7",
          target: "127.0.0.1:15003",
          startEmulator: true,
          foldControl: true,
        },
        foldServerScript: "fold-server.py",
        hdc: "hdc",
        runCommand: async (command) => ({
          stdout: command.endsWith("fport ls") ? "[Empty]" : "OK",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        stateRoot,
        runtime: {
          spawnProcess: () => children[spawnIndex++]!,
          checkHealth: async () => true,
          isPortAvailable: async () => availability.shift() ?? true,
          ownerToken: () => `bind-owner-${spawnIndex}`,
        },
      });

      assert.equal(instance.port, 8767);
      assert.equal(instance.process, healthyChild);
      assert.equal(spawnIndex, 2);
    } finally {
      for (const child of children) child.kill();
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("waits for forwarding and the host port to be released before deleting state", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fold-stop-test-"));
    const child = fakeChildProcess(4201);
    const state = {
      schemaVersion: 1 as const,
      pid: 4201,
      port: 8766,
      devicePort: 8765,
      target: "127.0.0.1:15003",
      ownerToken: "owned-token",
      forwardTask: "tcp:8765 tcp:8766",
      createdAt: "2026-08-11T00:00:00.000Z",
    };
    const stateFile = await foldServer.writeFoldServerState(
      state,
      "hdc",
      stateRoot,
    );
    const commands: string[] = [];
    const stopManaged = (
      foldServer as unknown as {
        stopManagedFoldServer?: (input: {
          instance: typeof state & { process: ChildProcess; stateFile: string };
          hdc: string;
          runCommand: (command: string) => Promise<{
            stdout: string;
            stderr: string;
            exitCode: number;
            durationMs: number;
          }>;
          runtime: { isPortAvailable: () => Promise<boolean> };
        }) => Promise<{ ok: boolean; diagnostics: string[] }>;
      }
    ).stopManagedFoldServer;
    assert.equal(typeof stopManaged, "function");

    try {
      const result = await stopManaged!({
        instance: { ...state, process: child, stateFile },
        hdc: "hdc",
        runCommand: async (command) => {
          commands.push(command);
          return {
            stdout: command.endsWith("fport ls") ? "[Empty]" : "OK",
            stderr: "",
            exitCode: 0,
            durationMs: 1,
          };
        },
        runtime: { isPortAvailable: async () => true },
      });

      assert.deepEqual(result, { ok: true, diagnostics: [] });
      assert.equal(child.killed, true);
      assert.ok(commands.some((command) => command.includes("fport rm")));
      assert.ok(commands.some((command) => command.endsWith("fport ls")));
      await assert.rejects(fs.access(stateFile));
    } finally {
      child.kill();
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("waits for an owned stale server port before reusing its port pair", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fold-recover-test-"));
    const oldState = {
      schemaVersion: 1 as const,
      pid: 4301,
      port: 8766,
      devicePort: 8765,
      target: "127.0.0.1:15003",
      ownerToken: "old-owner",
      forwardTask: "tcp:8765 tcp:8766",
      createdAt: "2026-08-11T00:00:00.000Z",
    };
    await foldServer.writeFoldServerState(oldState, "hdc", stateRoot);
    const child = fakeChildProcess(4302);
    const killedPids: number[] = [];
    const availability = [false, false, true, true];

    try {
      const instance = await foldServer.startManagedFoldServer({
        device: {
          id: "foldable",
          profile: "Mate X7",
          target: oldState.target,
          startEmulator: true,
          foldControl: true,
        },
        foldServerScript: "fold-server.py",
        hdc: "hdc",
        runCommand: async () => ({
          stdout: "OK",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        stateRoot,
        runtime: {
          spawnProcess: () => child,
          checkHealth: async () => true,
          isPortAvailable: async () => availability.shift() ?? true,
          ownerToken: () => "new-owner",
          killPid: (pid) => killedPids.push(pid),
          sleep: async () => undefined,
        },
      });

      assert.deepEqual(killedPids, [oldState.pid]);
      assert.equal(instance.port, 8766);
    } finally {
      child.kill();
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("removes stale forwarding after the previously owned process has exited", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fold-exited-test-"));
    const oldState = {
      schemaVersion: 1 as const,
      pid: 4321,
      port: 8766,
      devicePort: 8765,
      target: "127.0.0.1:15003",
      ownerToken: "exited-owner",
      forwardTask: "tcp:8765 tcp:8766",
      createdAt: "2026-08-11T00:00:00.000Z",
    };
    await foldServer.writeFoldServerState(oldState, "hdc", stateRoot);
    const child = fakeChildProcess(4322);
    const healthResults = [false, true];
    const killedPids: number[] = [];

    try {
      const instance = await foldServer.startManagedFoldServer({
        device: {
          id: "foldable",
          profile: "Mate X7",
          target: oldState.target,
          startEmulator: true,
          foldControl: true,
        },
        foldServerScript: "fold-server.py",
        hdc: "hdc",
        runCommand: async (command) => ({
          stdout: command.endsWith("fport ls") ? "[Empty]" : "OK",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        stateRoot,
        runtime: {
          spawnProcess: () => child,
          checkHealth: async () => healthResults.shift() ?? true,
          isPortAvailable: async () => true,
          ownerToken: () => "new-owner",
          killPid: (pid) => killedPids.push(pid),
        },
      });

      assert.equal(instance.port, 8766);
      assert.deepEqual(killedPids, []);
    } finally {
      child.kill();
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("does not kill an external service occupying a stale state port", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fold-foreign-test-"));
    const oldState = {
      schemaVersion: 1 as const,
      pid: 4351,
      port: 8766,
      devicePort: 8765,
      target: "127.0.0.1:15003",
      ownerToken: "old-owner",
      forwardTask: "tcp:8765 tcp:8766",
      createdAt: "2026-08-11T00:00:00.000Z",
    };
    const stateFile = await foldServer.writeFoldServerState(
      oldState,
      "hdc",
      stateRoot,
    );
    const killedPids: number[] = [];
    const commands: string[] = [];
    let spawnCount = 0;

    try {
      await assert.rejects(
        foldServer.startManagedFoldServer({
          device: {
            id: "foldable",
            profile: "Mate X7",
            target: oldState.target,
            startEmulator: true,
            foldControl: true,
          },
          foldServerScript: "fold-server.py",
          hdc: "hdc",
          runCommand: async (command) => {
            commands.push(command);
            return {
              stdout: command.endsWith("fport ls") ? "[Empty]" : "OK",
              stderr: "",
              exitCode: 0,
              durationMs: 1,
            };
          },
          stateRoot,
          runtime: {
            spawnProcess: () => {
              spawnCount += 1;
              return fakeChildProcess(4352);
            },
            checkHealth: async () => false,
            isPortAvailable: async () => false,
            killPid: (pid) => killedPids.push(pid),
          },
        }),
        /fold_cleanup_failed/,
      );

      assert.equal(spawnCount, 0);
      assert.deepEqual(killedPids, []);
      assert.deepEqual(commands, []);
      await fs.access(stateFile);
    } finally {
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("reports corrupt recovery state as a cleanup failure", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fold-corrupt-test-"));
    const stateFile = await foldServer.writeFoldServerState(
      {
        schemaVersion: 1,
        pid: 4401,
        port: 8766,
        devicePort: 8765,
        target: "127.0.0.1:15003",
        ownerToken: "corrupt-owner",
        forwardTask: "tcp:8765 tcp:8766",
        createdAt: "2026-08-11T00:00:00.000Z",
      },
      "hdc",
      stateRoot,
    );
    await fs.writeFile(stateFile, "{not-json", "utf-8");

    try {
      await assert.rejects(
        foldServer.startManagedFoldServer({
          device: {
            id: "foldable",
            profile: "Mate X7",
            target: "127.0.0.1:15003",
            startEmulator: true,
            foldControl: true,
          },
          foldServerScript: "fold-server.py",
          hdc: "hdc",
          runCommand: async () => ({
            stdout: "OK",
            stderr: "",
            exitCode: 0,
            durationMs: 1,
          }),
          stateRoot,
        }),
        /fold_cleanup_failed/,
      );
      await fs.access(stateFile);
    } finally {
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("blocks recovery while the stale reverse task is still listed", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fold-forward-test-"));
    const oldState = {
      schemaVersion: 1 as const,
      pid: 4501,
      port: 8766,
      devicePort: 8765,
      target: "127.0.0.1:15003",
      ownerToken: "stale-owner",
      forwardTask: "tcp:8765 tcp:8766",
      createdAt: "2026-08-11T00:00:00.000Z",
    };
    await foldServer.writeFoldServerState(oldState, "hdc", stateRoot);
    const child = fakeChildProcess(4502);
    const healthResults = [false, true];

    try {
      await assert.rejects(
        foldServer.startManagedFoldServer({
          device: {
            id: "foldable",
            profile: "Mate X7",
            target: oldState.target,
            startEmulator: true,
            foldControl: true,
          },
          foldServerScript: "fold-server.py",
          hdc: "hdc",
          runCommand: async (command) => ({
            stdout: command.endsWith("fport ls") ? oldState.forwardTask : "OK",
            stderr: "",
            exitCode: 0,
            durationMs: 1,
          }),
          stateRoot,
          runtime: {
            spawnProcess: () => child,
            checkHealth: async () => healthResults.shift() ?? true,
            isPortAvailable: async () => true,
            ownerToken: () => "new-owner",
          },
        }),
        /fold_cleanup_failed/,
      );
    } finally {
      child.kill();
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("stops the candidate and retains recovery state when rollback cannot remove forwarding", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fold-rollback-test-"));
    const child = fakeChildProcess(4601);

    try {
      await assert.rejects(
        foldServer.startManagedFoldServer({
          device: {
            id: "foldable",
            profile: "Mate X7",
            target: "127.0.0.1:15003",
            startEmulator: true,
            foldControl: true,
          },
          foldServerScript: "fold-server.py",
          hdc: "hdc",
          runCommand: async (command) => {
            if (command.includes(" fport rm ")) {
              throw new Error("hdc disconnected");
            }
            return {
              stdout: "port exists",
              stderr: "",
              exitCode: 1,
              durationMs: 1,
            };
          },
          stateRoot,
          runtime: {
            spawnProcess: () => child,
            checkHealth: async () => true,
            isPortAvailable: async () => true,
            ownerToken: () => "rollback-owner",
          },
        }),
        /fold_cleanup_failed/,
      );

      assert.equal(child.killed, true);
      assert.equal((await fs.readdir(stateRoot)).length, 1);
    } finally {
      child.kill();
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("retains recovery state when rollback still lists the forwarding task", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fold-rollback-list-test-"));
    const child = fakeChildProcess(4651);
    const forwardTask = "tcp:8765 tcp:8766";
    let spawnCount = 0;

    try {
      await assert.rejects(
        foldServer.startManagedFoldServer({
          device: {
            id: "foldable",
            profile: "Mate X7",
            target: "127.0.0.1:15003",
            startEmulator: true,
            foldControl: true,
          },
          foldServerScript: "fold-server.py",
          hdc: "hdc",
          runCommand: async (command) => ({
            stdout: command.endsWith("fport ls") ? forwardTask : "port exists",
            stderr: "",
            exitCode: command.endsWith("fport ls") ? 0 : 1,
            durationMs: 1,
          }),
          stateRoot,
          runtime: {
            spawnProcess: () => {
              spawnCount += 1;
              if (spawnCount > 1) throw new Error("unexpected retry");
              return child;
            },
            checkHealth: async () => true,
            isPortAvailable: async () => true,
            ownerToken: () => "rollback-list-owner",
          },
        }),
        /fold_cleanup_failed/,
      );

      assert.equal(child.killed, true);
      assert.equal(spawnCount, 1);
      assert.equal((await fs.readdir(stateRoot)).length, 1);
    } finally {
      child.kill();
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("allows repeated stops after resources are already released", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fold-repeat-stop-test-"));
    const child = fakeChildProcess(4701);
    const state = {
      schemaVersion: 1 as const,
      pid: 4701,
      port: 8766,
      devicePort: 8765,
      target: "127.0.0.1:15003",
      ownerToken: "repeat-owner",
      forwardTask: "tcp:8765 tcp:8766",
      createdAt: "2026-08-11T00:00:00.000Z",
    };
    const stateFile = await foldServer.writeFoldServerState(
      state,
      "hdc",
      stateRoot,
    );
    const instance = { ...state, process: child, stateFile };
    const stopInput = {
      instance,
      hdc: "hdc",
      runCommand: async (command: string) => ({
        stdout: command.endsWith("fport ls") ? "[Empty]" : "OK",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      }),
      runtime: { isPortAvailable: async () => true },
    };

    try {
      assert.deepEqual(await foldServer.stopManagedFoldServer(stopInput), {
        ok: true,
        diagnostics: [],
      });
      assert.deepEqual(await foldServer.stopManagedFoldServer(stopInput), {
        ok: true,
        diagnostics: [],
      });
    } finally {
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("retains state when the host port does not close", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fold-port-stuck-test-"));
    const child = fakeChildProcess(4801);
    const state = {
      schemaVersion: 1 as const,
      pid: 4801,
      port: 8766,
      devicePort: 8765,
      target: "127.0.0.1:15003",
      ownerToken: "stuck-owner",
      forwardTask: "tcp:8765 tcp:8766",
      createdAt: "2026-08-11T00:00:00.000Z",
    };
    const stateFile = await foldServer.writeFoldServerState(
      state,
      "hdc",
      stateRoot,
    );

    try {
      const result = await foldServer.stopManagedFoldServer({
        instance: { ...state, process: child, stateFile },
        hdc: "hdc",
        runCommand: async (command) => ({
          stdout: command.endsWith("fport ls") ? "[Empty]" : "OK",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        runtime: {
          isPortAvailable: async () => false,
          sleep: async () => undefined,
        },
      });

      assert.equal(result.ok, false);
      assert.deepEqual(result.diagnostics, ["fold_server_port_release_failed"]);
      await fs.access(stateFile);
    } finally {
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
  });
});

function fakeChildProcess(pid: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperties(child, {
    pid: { value: pid, configurable: true },
    stdout: { value: new PassThrough(), configurable: true },
    stderr: { value: new PassThrough(), configurable: true },
    exitCode: { value: null, writable: true, configurable: true },
    killed: { value: false, writable: true, configurable: true },
  });
  child.kill = (() => {
    Object.defineProperty(child, "killed", { value: true, writable: true });
    Object.defineProperty(child, "exitCode", { value: 0, writable: true });
    queueMicrotask(() => child.emit("close", 0, "SIGTERM"));
    return true;
  }) as ChildProcess["kill"];
  return child;
}

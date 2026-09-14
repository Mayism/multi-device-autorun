import assert from "node:assert/strict";
import test from "node:test";
import {
  registerOwnedProcessTree,
  signalOwnedProcessTree,
} from "../runtime/owned-process-tree.mjs";

test("POSIX owned server signal reaches the detached process group", () => {
  const child = registerOwnedProcessTree({ pid: 4321, exitCode: null, signalCode: null }, { detached: true });
  const calls = [];

  assert.equal(signalOwnedProcessTree(child, "SIGTERM", {
    platform: "darwin",
    killProcess: (pid, signal) => calls.push({ pid, signal }),
  }), true);
  assert.deepEqual(calls, [{ pid: -4321, signal: "SIGTERM" }]);
});

test("detached process group can still be stopped after its launcher exits", () => {
  const child = registerOwnedProcessTree({ pid: 7654, exitCode: 0, signalCode: null }, { detached: true });
  const calls = [];

  assert.equal(signalOwnedProcessTree(child, "SIGKILL", {
    platform: "linux",
    killProcess: (pid, signal) => calls.push({ pid, signal }),
  }), true);
  assert.deepEqual(calls, [{ pid: -7654, signal: "SIGKILL" }]);
});

test("Windows falls back to the child handle for a live launcher", () => {
  const calls = [];
  const child = {
    pid: 2468,
    exitCode: null,
    signalCode: null,
    kill(signal) {
      calls.push(signal);
      return true;
    },
  };

  assert.equal(signalOwnedProcessTree(child, "SIGTERM", { platform: "win32" }), true);
  assert.deepEqual(calls, ["SIGTERM"]);
});

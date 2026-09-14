import assert from "node:assert/strict";
import test from "node:test";
import {
  checkConfiguredEmulatorPorts,
  formatEmulatorPortConflict,
} from "./emulator-hdc-port-check.mjs";

test("emulator port check ignores devices that Autorun does not start", async () => {
  const probed = [];
  const conflicts = await checkConfiguredEmulatorPorts({
    devices: [
      { id: "manual", hdcPort: 15001, startEmulator: false },
      { id: "missing-port", startEmulator: true },
    ],
  }, {
    probePort: async (port) => {
      probed.push(port);
      return false;
    },
  });

  assert.deepEqual(conflicts, []);
  assert.deepEqual(probed, []);
});

test("emulator port check recommends a probed free port and skips configured ports", async () => {
  const unavailable = new Set([15001, 15002]);
  const conflicts = await checkConfiguredEmulatorPorts({
    devices: [
      { id: "phone", profile: "Pura 90 Pro", hdcPort: 15001, startEmulator: true },
      { id: "foldable", profile: "Mate X7", hdcPort: 15003, startEmulator: true },
    ],
  }, {
    probePort: async (port) => !unavailable.has(port),
  });

  assert.deepEqual(conflicts, [{
    id: "phone",
    profile: "Pura 90 Pro",
    port: 15001,
    recommendedPort: 15004,
  }]);
});

test("emulator port conflict format includes both config fields", () => {
  assert.equal(
    formatEmulatorPortConflict({
      id: "phone",
      profile: "Pura 90 Pro",
      port: 15001,
      recommendedPort: 15002,
    }),
    "模拟器 phone（Pura 90 Pro）：HDC 端口 15001 已被占用；推荐同时将 target 改为 127.0.0.1:15002、hdcPort 改为 15002",
  );
});

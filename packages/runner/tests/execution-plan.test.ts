import assert from "node:assert/strict";
import test from "node:test";
import { buildExecutionPlan } from "../src/execution/plan.js";
import type { DeviceConfig } from "../src/execution/types/index.js";

const devices: DeviceConfig[] = [
  {
    id: "phone",
    target: "127.0.0.1:15001",
    startEmulator: false,
    testClasses: ["MachineSuite"],
  },
  {
    id: "tablet",
    target: "127.0.0.1:15003",
    startEmulator: false,
  },
];
const config = { devices };

test("buildExecutionPlan applies mode suite policy", () => {
  assert.deepEqual(
    buildExecutionPlan(config, {
      suitesByDevice: { phone: ["MetadataSuite", "MetadataSuite"] },
    }).devices[0]?.testClasses,
    ["MetadataSuite"],
  );
  assert.equal(
    buildExecutionPlan(config, { runAllTests: true }).devices[0]?.testClasses,
    undefined,
  );
  assert.deepEqual(
    buildExecutionPlan(config, {
      testClass: "OnlyThisSuite",
      suitesByDevice: { phone: ["MetadataSuite"] },
    }).devices[0]?.testClasses,
    ["OnlyThisSuite"],
  );
});

test("buildExecutionPlan preserves requested order and rejects unknown devices", () => {
  assert.deepEqual(
    buildExecutionPlan(config, { devices: ["tablet", "phone"] }).devices.map(
      (device) => device.id,
    ),
    ["tablet", "phone"],
  );
  assert.throws(
    () => buildExecutionPlan(config, { devices: ["missing"] }),
    /device missing is missing in machine config/,
  );
});

import type { DeviceRunResult, ExecutionStatus } from "./types/index.js";

export function deriveExecutionStatus(
  devices: DeviceRunResult[],
): ExecutionStatus {
  if (devices.length === 0) {
    return "failed";
  }
  if (
    devices.some((device) => ["blocked", "timed_out"].includes(device.status))
  ) {
    return "failed";
  }
  return "completed";
}

export function aggregateDeviceCounts(devices: DeviceRunResult[]): {
  testsRun: number;
  failures: number;
  errors: number;
  passes: number;
  ignored: number;
} {
  return devices.reduce(
    (total, device) => ({
      testsRun: total.testsRun + device.testsRun,
      failures: total.failures + device.failures,
      errors: total.errors + device.errors,
      passes: total.passes + device.passes,
      ignored: total.ignored + device.ignored,
    }),
    { testsRun: 0, failures: 0, errors: 0, passes: 0, ignored: 0 },
  );
}

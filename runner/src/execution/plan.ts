import type {
  DeviceConfig,
  ExecutionConfig,
  ExecutionPlan,
} from "./types/index.js";

export interface BuildExecutionPlanInput {
  devices?: string[];
  testClass?: string;
  suitesByDevice?: Record<string, string[]>;
  runAllTests?: boolean;
}

export function buildExecutionPlan(
  config: Pick<ExecutionConfig, "devices">,
  input: BuildExecutionPlanInput = {},
): ExecutionPlan {
  const selected = selectExecutionDevices(config.devices, input.devices);
  return {
    devices: selected.map((device) => {
      const requestedSuites = input.suitesByDevice?.[device.id];
      const testClasses = input.testClass
        ? [input.testClass]
        : input.runAllTests
          ? undefined
          : (requestedSuites ?? device.testClasses);
      return {
        ...device,
        ...(testClasses && testClasses.length > 0
          ? { testClasses: dedupe(testClasses) }
          : { testClasses: undefined }),
      };
    }),
  };
}

export function selectExecutionDevices(
  available: DeviceConfig[],
  requested?: string[],
): DeviceConfig[] {
  if (!requested || requested.length === 0) return available;
  const byId = new Map(available.map((device) => [device.id, device]));
  return dedupe(requested).map((id) => {
    const device = byId.get(id);
    if (!device) {
      throw new Error(`device ${id} is missing in machine config.`);
    }
    return device;
  });
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

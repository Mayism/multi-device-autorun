import type { RunMatrixInput } from "../matrix/types/index.js";

const knownMatrixArgs = new Set([
  "--project",
  "--machine-config",
  "--out",
  "--device",
  "--test-class",
  "--skip-build",
  "--keep-emulators",
]);

export function parseOhosTestMatrixArgs(args: string[]): RunMatrixInput {
  const values = new Map<string, string>();
  const devices: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) {
      continue;
    }
    if (!knownMatrixArgs.has(arg)) {
      throw new Error(`未知参数 ${arg}。`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`参数 ${arg} 缺少取值。`);
    }
    if (arg === "--device") {
      devices.push(value);
    } else {
      values.set(arg, value);
    }
    index += 1;
  }

  const project = values.get("--project");
  if (!project) {
    throw new Error("缺少必填参数 --project。");
  }
  const machineConfigPath = values.get("--machine-config");

  return {
    project,
    ...(machineConfigPath ? { machineConfigPath } : {}),
    ...(values.has("--out") ? { out: values.get("--out") } : {}),
    ...(devices.length > 0 ? { devices } : {}),
    ...(values.has("--test-class")
      ? { testClass: values.get("--test-class") }
      : {}),
    ...(values.has("--skip-build")
      ? { skipBuild: readBoolean(values.get("--skip-build")) }
      : {}),
    ...(values.has("--keep-emulators")
      ? { keepEmulators: readBoolean(values.get("--keep-emulators")) }
      : {}),
  };
}

function readBoolean(value: string | undefined): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error("boolean 参数必须是 true 或 false。");
}

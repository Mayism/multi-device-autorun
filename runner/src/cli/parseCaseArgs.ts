import type { CaseRunMode, RunCaseInput } from "../case/types/index.js";

const knownCaseArgs = new Set([
  "--case",
  "--machine-config",
  "--out",
  "--skip-build",
  "--keep-emulators",
  "--keep-workdir",
  "--run",
  "--device",
]);

export function parseOhosTestCaseArgs(args: string[]): RunCaseInput {
  const values = new Map<string, string>();
  const devices: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) {
      continue;
    }
    if (!knownCaseArgs.has(arg)) {
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

  const caseDir = values.get("--case");
  if (!caseDir) {
    throw new Error("缺少必填参数 --case。");
  }
  const machineConfigPath = values.get("--machine-config");
  const runMode = readRunMode(values.get("--run"));

  return {
    caseDir,
    ...(devices.length > 0 ? { devices } : {}),
    ...(machineConfigPath ? { machineConfigPath } : {}),
    ...(values.has("--out") ? { out: values.get("--out") } : {}),
    runMode,
    ...(values.has("--skip-build")
      ? { skipBuild: readBoolean(values.get("--skip-build")) }
      : {}),
    ...(values.has("--keep-emulators")
      ? { keepEmulators: readBoolean(values.get("--keep-emulators")) }
      : {}),
    ...(values.has("--keep-workdir")
      ? { keepWorkdir: readBoolean(values.get("--keep-workdir")) }
      : {}),
  };
}

function readRunMode(value: string | undefined): CaseRunMode {
  if (!value) {
    return "answer";
  }
  if (value === "answer" || value === "swe" || value === "all") {
    return value;
  }
  throw new Error("参数 --run 只支持 answer、swe、all。");
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

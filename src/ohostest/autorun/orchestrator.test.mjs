import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { loadOhosTestConfig } from "./orchestrator.mjs";
import { runPythonWorker } from "../../runtime/python-worker.mjs";

test("ohosTest config normalizes runner paths and environment", async () => {
  const baseDir = path.join(os.tmpdir(), "autorun-ohostest-config");
  const settings = await loadOhosTestConfig({
    __baseDir: baseDir,
    server: { sdkHome: "/sdk", javaHome: "/java" },
    ohosTest: {
      enabled: true,
      timeoutSec: "90",
      paths: { foldServerScript: "tools/fold-server.py" },
      devices: [{ id: "device-1", startEmulator: false }],
    },
  });
  assert.equal(settings.enabled, true);
  assert.equal(settings.timeoutSec, 90);
  assert.equal(settings.runMode, "swe");
  assert.equal(settings.machineConfig.paths.foldServerScript, path.join(baseDir, "tools/fold-server.py"));
  assert.equal(settings.runnerEnv.DEVECO_SDK_HOME, "/sdk");
  assert.equal(settings.runnerEnv.HOS_SDK_HOME, "/sdk");
  assert.equal(settings.runnerEnv.OHOS_SDK_HOME, "/sdk");
  assert.equal(settings.runnerEnv.JAVA_HOME, "/java");
  assert.ok(settings.runnerVersion);
});

test("ohosTest result classification preserves timeout and diagnostic precedence", async () => {
  const result = async (input) => JSON.parse((await runPythonWorker("ohostest-result", {
    inputDir: "/case", ...input,
  })).toString("utf8"));
  assert.deepEqual(await result({ runnerStatus: "completed", stopReason: "", exitCode: 1 }),
    { status: "completed", error: "" });
  assert.deepEqual(await result({ runnerStatus: "failed", stopReason: "ohosTest 总运行时间超过 90 秒", exitCode: null }),
    { status: "timed_out", error: "ohosTest 总运行时间超过 90 秒" });
  assert.deepEqual(await result({ runnerStatus: "failed", firstDiagnostic: "test assertion failed", stopReason: "", exitCode: 1 }),
    { status: "failed", error: "test assertion failed" });
  assert.deepEqual(await result({ runnerStatus: "failed", stopReason: "", exitCode: null }),
    { status: "failed", error: "ohostest:case 退出码 null" });
});

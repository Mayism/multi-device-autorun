import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadCloudTestConfig } from "./cloudtest-orchestrator.mjs";
import { summarizeTaskReport } from "./cloudtest-report.mjs";
import { runPythonWorkerSync } from "../runtime/python-worker.mjs";

test("cloud test config keeps credential, tool and signing path precedence", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-cloud-config-"));
  try {
    await fs.writeFile(path.join(baseDir, "agc-cookie.txt"), "  cookie-value\r\n");
    const settings = loadCloudTestConfig({
      __baseDir: baseDir,
      server: { hvigorw: "custom-hvigor", sdkHome: "/sdk" },
      ohosTest: { paths: { hvigorw: "fallback-hvigor", ohpm: "fallback-ohpm" } },
      cloudTest: {
        teamId: "team", projectId: "project", testCategories: [{ category: "25", timeSpan: 0 }],
        signingConfigs: [{ material: { storeFile: "keys/app.p12", profile: "/outside/profile.p7b" } }],
      },
    });
    assert.equal(settings.agcAuthInfo, "cookie-value");
    assert.equal(settings.cookieFile, path.join(baseDir, "agc-cookie.txt"));
    assert.deepEqual(settings.paths, {
      hvigorw: "custom-hvigor", ohpm: "fallback-ohpm", sdkHome: "/sdk", javaHome: "",
    });
    assert.deepEqual(settings.testCategories, [{ category: 25, timeSpan: 60 }]);
    assert.equal(settings.signingConfigs[0].material.storeFile, path.join(baseDir, "keys/app.p12"));
    assert.equal(settings.signingConfigs[0].material.profile, "/outside/profile.p7b");
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test("cloud test decisions rank idle devices and keep terminal status semantics", () => {
  const devices = [
    { id: "queued", idleDeviceCount: 0, usableNumber: 2, waitTime: 1 },
    { id: "idle-slow", idleDeviceCount: 1, usableNumber: 2, waitTime: 8 },
    { id: "idle-fast", idleDeviceCount: 1, usableNumber: 2, waitTime: 2 },
    { id: "unavailable", idleDeviceCount: 0, usableNumber: 0, waitTime: 0 },
  ];
  const ranked = JSON.parse(runPythonWorkerSync("cloudtest-rank-devices", { devices }).toString("utf8"));
  assert.deepEqual(ranked.map((device) => device.id), ["idle-fast", "idle-slow", "queued", "unavailable"]);
  const finished = JSON.parse(runPythonWorkerSync("cloudtest-final-status", {
    taskGroup: { status: 2, resultStatus: 1 },
  }).toString("utf8"));
  assert.deepEqual(finished, { status: "completed", error: "" });
});

test("cloud test report summary counts device and rule results", () => {
  assert.deepEqual(summarizeTaskReport({
    taskList: [{ resultStatus: "1" }, { resultStatus: 2 }, { resultStatus: 0 }],
    overview: { categoryResults: [{ ruleInfo: { passedErrorCount: "7", failedErrorCount: 2 } }] },
    problems: [{}, {}],
  }), {
    deviceCount: 3, devicePassed: 1, deviceFailed: 1,
    rulePassed: 7, ruleFailed: 2, issueCount: 2,
  });
});

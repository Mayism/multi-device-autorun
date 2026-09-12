import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runOhosTestCase } from "../src/index.js";
import { loadExecutionConfig } from "../src/execution/config.js";
import { readRnBuildSettings } from "../src/case/platform.js";

async function makeRnProject(root: string): Promise<string> {
  const rnRoot = path.join(root, "base");
  await fs.mkdir(rnRoot, { recursive: true });
  await fs.writeFile(
    path.join(rnRoot, "package.json"),
    JSON.stringify(
      {
        name: "im",
        version: "1.0.0",
        private: true,
        scripts: {
          codegen:
            "react-native codegen-harmony --cpp-output-path ./harmony/products/entry/src/main/cpp/generated",
          dev: "npm run codegen && react-native bundle-harmony --dev",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  await fs.writeFile(
    path.join(rnRoot, "App.tsx"),
    "export const app = 'base';\n",
    "utf-8",
  );

  const harmony = path.join(rnRoot, "harmony");
  await fs.mkdir(path.join(harmony, "AppScope"), { recursive: true });
  await fs.writeFile(
    path.join(harmony, "AppScope", "app.json5"),
    JSON.stringify({ app: { bundleName: "org.rn.case" } }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(harmony, "build-profile.json5"),
    JSON.stringify({
      app: { products: [{ name: "default" }] },
      modules: [{ name: "entry", srcPath: "./products/entry" }],
    }),
    "utf-8",
  );
  const moduleRoot = path.join(harmony, "products", "entry");
  await fs.mkdir(path.join(moduleRoot, "src", "main", "ets"), {
    recursive: true,
  });
  await fs.mkdir(path.join(moduleRoot, "src", "ohosTest"), { recursive: true });
  await fs.writeFile(
    path.join(moduleRoot, "hvigorfile.ts"),
    "import { hapTasks } from '@ohos/hvigor-ohos-plugin';\nexport default { system: hapTasks, plugins: [] };\n",
    "utf-8",
  );
  await fs.writeFile(
    path.join(moduleRoot, "src", "main", "ets", "Index.ets"),
    "export const state = 'base';\n",
    "utf-8",
  );
  await fs.writeFile(
    path.join(moduleRoot, "src", "main", "module.json5"),
    JSON.stringify({ module: { name: "entry", deviceTypes: ["phone"] } }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(moduleRoot, "src", "ohosTest", "module.json5"),
    JSON.stringify({ module: { name: "entry_test" } }),
    "utf-8",
  );
  await fs.mkdir(
    path.join(moduleRoot, "build", "default", "outputs", "default"),
    { recursive: true },
  );
  await fs.mkdir(
    path.join(moduleRoot, "build", "default", "outputs", "ohosTest"),
    { recursive: true },
  );
  await fs.writeFile(
    path.join(
      moduleRoot,
      "build",
      "default",
      "outputs",
      "default",
      "entry-default-unsigned.hap",
    ),
    "",
    "utf-8",
  );
  await fs.writeFile(
    path.join(
      moduleRoot,
      "build",
      "default",
      "outputs",
      "ohosTest",
      "entry-ohosTest-unsigned.hap",
    ),
    "",
    "utf-8",
  );
  return rnRoot;
}

async function writeMachineConfig(root: string): Promise<string> {
  const machineConfigPath = path.join(root, "machine.json");
  await fs.writeFile(
    machineConfigPath,
    JSON.stringify({
      paths: {
        hdc: "/fake/hdc",
        hvigorw: "/fake/hvigorw",
        emulatorBin: "/fake/Emulator",
        emulatorDeployedDir: "/fake/deployed",
      },
      devices: [{ id: "phone", target: "127.0.0.1:15001" }],
    }),
    "utf-8",
  );
  return machineConfigPath;
}

async function writeRnCase(root: string): Promise<string> {
  const caseDir = path.join(root, "case");
  await fs.mkdir(caseDir, { recursive: true });
  await fs.writeFile(
    path.join(caseDir, "metadata.json"),
    JSON.stringify({
      platform: "rn",
      case_id: "rn-case",
      base_project: "base",
      test_patch: "test_patch.patch",
      golden_patch: "golden_patch.patch",
      fail_to_pass: ["should_render_list"],
      pass_to_pass: ["should_launch"],
      device_test_suites: {
        phone: [{ suite: "RnSuite" }],
      },
    }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(caseDir, "test_patch.patch"),
    [
      "diff --git a/harmony/products/entry/src/main/ets/RnOnly.ets b/harmony/products/entry/src/main/ets/RnOnly.ets",
      "new file mode 100644",
      "index 0000000..8f0b6af",
      "--- /dev/null",
      "+++ b/harmony/products/entry/src/main/ets/RnOnly.ets",
      "@@ -0,0 +1 @@",
      "+export const testOnly = true;",
      "",
    ].join("\n"),
    "utf-8",
  );
  await fs.writeFile(
    path.join(caseDir, "golden_patch.patch"),
    [
      "diff --git a/App.tsx b/App.tsx",
      "index 2e5ab31..43d9d25 100644",
      "--- a/App.tsx",
      "+++ b/App.tsx",
      "@@ -1 +1 @@",
      "-export const app = 'base';",
      "+export const app = 'answer';",
      "",
    ].join("\n"),
    "utf-8",
  );
  return caseDir;
}

test("loadExecutionConfig re-points rn projects at the harmony shell", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohostest-rn-config-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const rnRoot = await makeRnProject(root);
  const machineConfigPath = await writeMachineConfig(root);

  const config = await loadExecutionConfig({
    project: rnRoot,
    machineConfigPath,
    platform: "rn",
  });

  assert.equal(config.project, path.join(rnRoot, "harmony"));
  assert.equal(config.rn?.root, rnRoot);
  assert.equal(config.bundleName, "org.rn.case");
});

test("loadExecutionConfig rejects rn projects without a harmony shell", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohostest-rn-empty-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const machineConfigPath = await writeMachineConfig(root);
  await fs.mkdir(path.join(root, "not-rn"), { recursive: true });

  await assert.rejects(
    loadExecutionConfig({
      project: path.join(root, "not-rn"),
      machineConfigPath,
      platform: "rn",
    }),
    /case_rn_harmony_missing/,
  );
});

test("rn Case rebuilds the RN bundle each round from the RN root", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohostest-rn-case-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await makeRnProject(root);
  const caseDir = await writeRnCase(root);
  const machineConfigPath = await writeMachineConfig(root);
  const out = path.join(root, "runs");
  const workProject = path.join(out, "work", "project");
  const harmonyProject = path.join(workProject, "harmony");
  const steps: Array<{ command: string; cwd: string }> = [];

  const result = await runOhosTestCase({
    caseDir,
    machineConfigPath,
    out,
    runMode: "all",
    keepWorkdir: true,
    patchCommandExecutor: async (command, cwd) => {
      steps.push({ command, cwd });
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
    },
    commandExecutor: async (command, cwd) => {
      steps.push({ command, cwd });
      return {
        stdout: command.includes("aa test")
          ? "OHOS_REPORT_RESULT: stream=Tests run: 1, Failure: 0, Error: 0, Pass: 1, Ignore: 0\nOHOS_REPORT_CODE: 0\n"
          : command.includes("list targets")
            ? "127.0.0.1:15001\tConnected"
            : "",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      };
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.metadata.platform, "rn");

  const firstNpm = steps.findIndex(
    (step) => step.command === "npm install --force",
  );
  assert.ok(firstNpm > 0, "expected a git apply before the RN build steps");
  assert.match(steps[firstNpm - 1]!.command, /git apply/);
  assert.match(steps[firstNpm - 1]!.command, /test_patch/);

  assert.deepEqual(steps.slice(firstNpm, firstNpm + 7), [
    { command: "npm install --force", cwd: workProject },
    { command: "ohpm install", cwd: harmonyProject },
    {
      command:
        "npx react-native codegen-harmony --cpp-output-path ./harmony/entry/src/main/cpp/generated --rnoh-module-path ./harmony/entry/oh_modules/@rnoh/react-native-openharmony",
      cwd: workProject,
    },
    { command: "npx react-native bundle-harmony --dev", cwd: workProject },
    {
      command: "/fake/hvigorw clean --no-daemon",
      cwd: harmonyProject,
    },
    {
      command:
        "/fake/hvigorw --mode module -p product=default assembleHap --no-daemon",
      cwd: harmonyProject,
    },
    {
      command:
        "/fake/hvigorw --mode module -p module=entry@ohosTest ohosTest@PackageHap --no-daemon --stacktrace",
      cwd: harmonyProject,
    },
  ]);

  // swe 与 answer 两轮各自完整重建 RN 产物。
  assert.equal(
    steps.filter((step) => step.command === "npm install --force").length,
    2,
  );
  assert.equal(
    steps.filter((step) => step.command.startsWith("npx react-native")).length,
    4,
  );
  assert.equal(
    steps.filter((step) => step.command === "ohpm install").length,
    2,
  );
  assert.equal(
    steps.filter((step) => step.command.includes("--stop-daemon")).length,
    0,
  );

  const aaTestSteps = steps.filter((step) => step.command.includes("aa test"));
  assert.equal(aaTestSteps.length, 2);
  for (const step of aaTestSteps) {
    assert.match(step.command, /-b org\.rn\.case/);
    assert.match(step.command, /-s class RnSuite/);
  }

  const resultJson = JSON.parse(
    await fs.readFile(path.join(out, "result.json"), "utf-8"),
  ) as { metadata: { platform?: string } };
  assert.equal(resultJson.metadata.platform, "rn");
});

test("readRnBuildSettings validates bundle_commands and its rn-only usage", () => {
  assert.deepEqual(readRnBuildSettings({}), {});
  assert.deepEqual(
    readRnBuildSettings({
      platform: "rn",
      rn_build: { bundle_commands: ["npm run dev:all"] },
    }),
    { rnBuild: { bundleCommands: ["npm run dev:all"] } },
  );
  assert.deepEqual(
    readRnBuildSettings({
      platform: "rn",
      rn_build: {
        bundle_commands: ["npm run dev:basic", "npm run dev:base"],
      },
    }),
    { rnBuild: { bundleCommands: ["npm run dev:basic", "npm run dev:base"] } },
  );
  assert.throws(
    () => readRnBuildSettings({ platform: "native", rn_build: {} }),
    /rn_build is only valid/,
  );
  assert.throws(
    () => readRnBuildSettings({ platform: "rn", rn_build: {} }),
    /bundle_commands is required/,
  );
  assert.throws(
    () => readRnBuildSettings({ platform: "rn", rn_build: [] }),
    /must be an object/,
  );
  assert.throws(
    () =>
      readRnBuildSettings({
        platform: "rn",
        rn_build: { bundle_commands: [] },
      }),
    /non-empty array/,
  );
  assert.throws(
    () =>
      readRnBuildSettings({
        platform: "rn",
        rn_build: { bundle_commands: ["  "] },
      }),
    /non-empty string/,
  );
});

test("rn Case uses configured bundle_commands instead of the default bundle step", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohostest-rn-custom-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await makeRnProject(root);
  const caseDir = await writeRnCase(root);
  // 覆写 metadata 增加 rn_build.bundle_commands（补丁沿用 writeRnCase 的合法内容）。
  const metadataPath = path.join(caseDir, "metadata.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf-8"));
  metadata.rn_build = {
    bundle_commands: ["npm run dev:basic", "npm run dev:base"],
  };
  await fs.writeFile(metadataPath, JSON.stringify(metadata), "utf-8");
  const machineConfigPath = await writeMachineConfig(root);
  const out = path.join(root, "runs");
  const workProject = path.join(out, "work", "project");
  const steps: Array<{ command: string; cwd: string }> = [];

  const result = await runOhosTestCase({
    caseDir,
    machineConfigPath,
    out,
    runMode: "swe",
    commandExecutor: async (command, cwd) => {
      steps.push({ command, cwd });
      return {
        stdout: command.includes("aa test")
          ? "OHOS_REPORT_RESULT: stream=Tests run: 1, Failure: 0, Error: 0, Pass: 1, Ignore: 0\nOHOS_REPORT_CODE: 0\n"
          : command.includes("list targets")
            ? "127.0.0.1:15001\tConnected"
            : "",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      };
    },
  });

  assert.equal(result.status, "completed");
  const bundleSteps = steps.filter((step) =>
    ["npm run dev:basic", "npm run dev:base"].includes(step.command),
  );
  assert.deepEqual(bundleSteps, [
    { command: "npm run dev:basic", cwd: workProject },
    { command: "npm run dev:base", cwd: workProject },
  ]);
  assert.equal(
    steps.filter((step) => step.command.includes("bundle-harmony")).length,
    0,
    "configured bundle_commands must replace the default bundle-harmony step",
  );
  // codegen 与 npm 安装保持 runner 合成命令。
  assert.equal(
    steps.filter((step) => step.command.startsWith("npm install --force"))
      .length,
    1,
  );
  assert.equal(
    steps.filter((step) => step.command.includes("codegen-harmony")).length,
    1,
  );
});

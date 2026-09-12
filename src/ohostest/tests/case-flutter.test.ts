import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runOhosTestCase } from "../src/index.js";
import { loadExecutionConfig } from "../src/execution/config.js";

async function makeFlutterProject(root: string): Promise<string> {
  const flutterRoot = path.join(root, "base");
  await fs.mkdir(flutterRoot, { recursive: true });
  await fs.writeFile(
    path.join(flutterRoot, "pubspec.yaml"),
    ["name: demo", "environment:", "  sdk: ^3.9.2", ""].join("\n"),
    "utf-8",
  );
  await fs.mkdir(path.join(flutterRoot, "lib"), { recursive: true });
  await fs.writeFile(
    path.join(flutterRoot, "lib", "main.dart"),
    "export const app = 'base';\n",
    "utf-8",
  );

  const ohos = path.join(flutterRoot, "ohos");
  await fs.mkdir(path.join(ohos, "AppScope"), { recursive: true });
  await fs.writeFile(
    path.join(ohos, "AppScope", "app.json5"),
    JSON.stringify({ app: { bundleName: "org.flutter.case" } }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(ohos, "build-profile.json5"),
    JSON.stringify({
      app: { products: [{ name: "default" }] },
      modules: [{ name: "entry", srcPath: "./entry" }],
    }),
    "utf-8",
  );
  // hvigorfile.ts 只存在于 ohos/ 宿主内，是 flutter 工程形态的识别标志。
  await fs.writeFile(
    path.join(ohos, "hvigorfile.ts"),
    "import { appTasks } from '@ohos/hvigor-ohos-plugin';\nexport default { system: appTasks, plugins: [] };\n",
    "utf-8",
  );
  await writeHapModule(path.join(ohos, "entry"));
  return flutterRoot;
}

async function writeHapModule(moduleRoot: string): Promise<void> {
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
  await fs.mkdir(path.join(moduleRoot, "build", "default", "outputs", "default"), {
    recursive: true,
  });
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
}

async function makeFakeFlutterSdk(root: string): Promise<string> {
  const sdk = path.join(root, "flutter-sdk");
  await fs.mkdir(path.join(sdk, "bin"), { recursive: true });
  await fs.mkdir(path.join(sdk, "packages", "flutter_tools", "hvigor"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(sdk, "bin", process.platform === "win32" ? "flutter.bat" : "flutter"),
    "",
    "utf-8",
  );
  await fs.writeFile(
    path.join(sdk, "packages", "flutter_tools", "hvigor", "package.json"),
    JSON.stringify({ name: "flutter-hvigor-plugin" }),
    "utf-8",
  );
  return sdk;
}

async function writeMachineConfig(
  root: string,
  flutterSdk?: string,
): Promise<string> {
  const machineConfigPath = path.join(root, "machine.json");
  await fs.writeFile(
    machineConfigPath,
    JSON.stringify({
      paths: {
        hdc: "/fake/hdc",
        hvigorw: "/fake/hvigorw",
        emulatorBin: "/fake/Emulator",
        emulatorDeployedDir: "/fake/deployed",
        ...(flutterSdk ? { flutter: flutterSdk } : {}),
      },
      devices: [{ id: "phone", target: "127.0.0.1:15001" }],
    }),
    "utf-8",
  );
  return machineConfigPath;
}

async function writeFlutterCase(
  root: string,
  platform?: "flutter",
): Promise<string> {
  const caseDir = path.join(root, "case");
  await fs.mkdir(caseDir, { recursive: true });
  await fs.writeFile(
    path.join(caseDir, "metadata.json"),
    JSON.stringify({
      ...(platform ? { platform } : {}),
      case_id: "flutter-case",
      base_project: "base",
      test_patch: "test_patch.patch",
      golden_patch: "golden_patch.patch",
      fail_to_pass: ["should_render_grid"],
      pass_to_pass: ["should_launch"],
      device_test_suites: {
        phone: [{ suite: "FlutterSmSuite" }],
      },
    }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(caseDir, "test_patch.patch"),
    [
      "diff --git a/ohos/entry/src/main/ets/FlutterOnly.ets b/ohos/entry/src/main/ets/FlutterOnly.ets",
      "new file mode 100644",
      "index 0000000..8f0b6af",
      "--- /dev/null",
      "+++ b/ohos/entry/src/main/ets/FlutterOnly.ets",
      "@@ -0,0 +1 @@",
      "+export const testOnly = true;",
      "",
    ].join("\n"),
    "utf-8",
  );
  await fs.writeFile(
    path.join(caseDir, "golden_patch.patch"),
    [
      "diff --git a/lib/main.dart b/lib/main.dart",
      "index 2e5ab31..43d9d25 100644",
      "--- a/lib/main.dart",
      "+++ b/lib/main.dart",
      "@@ -1 +1 @@",
      "-export const app = 'base';",
      "+export const app = 'answer';",
      "",
    ].join("\n"),
    "utf-8",
  );
  return caseDir;
}

function fakeCommandResult(command: string) {
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
}

test("flutter Case redirects the build project to the ohos host", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohostest-flutter-case-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await makeFlutterProject(root);
  const flutterSdk = await makeFakeFlutterSdk(root);
  const caseDir = await writeFlutterCase(root, "flutter");
  const machineConfigPath = await writeMachineConfig(root, flutterSdk);
  const out = path.join(root, "runs");
  const workProject = path.join(out, "work", "project");
  const ohosProject = path.join(workProject, "ohos");
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
      return fakeCommandResult(command);
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.metadata.platform, "flutter");

  // 构建命令全部落在 ohos 宿主内，补丁打在 flutter 根。
  const ohpm = steps.find((step) => step.command === "ohpm install");
  assert.ok(ohpm, "expected an ohpm install step");
  assert.equal(ohpm.cwd, ohosProject);
  const patchStep = steps.find((step) => step.command.includes("git apply"));
  assert.ok(patchStep, "expected a git apply step");
  assert.equal(patchStep.cwd, workProject);

  // 每轮构建前在 flutter 根执行 pub get（golden_patch 可能新增 Dart 依赖），
  // SDK bin 来自 machine.json paths.flutter。
  const pubGets = steps.filter((step) => step.command.endsWith(" pub get"));
  assert.equal(pubGets.length, 2);
  for (const pubGet of pubGets) {
    assert.equal(pubGet.cwd, workProject);
    assert.ok(pubGet.command.includes(path.join(flutterSdk, "bin")));
  }
  // 每轮 pub get 先于对应的 ohpm install 执行。
  const firstPubGet = steps.findIndex((step) =>
    step.command.endsWith(" pub get"),
  );
  const firstOhpm = steps.findIndex((step) => step.command === "ohpm install");
  assert.ok(firstOhpm > firstPubGet, "expected pub get before ohpm install");

  // local.properties 由 machine.json 生成（case 不携带本机路径）。
  const properties = await fs.readFile(
    path.join(ohosProject, "local.properties"),
    "utf-8",
  );
  assert.match(properties, /^flutter\.sdk=.+flutter-sdk$/m);

  // node_modules 复制被排除后由 junction 自愈补齐 hvigor 插件。
  assert.ok(
    await fs.stat(path.join(ohosProject, "node_modules", "flutter-hvigor-plugin")),
    "expected the flutter hvigor plugin link",
  );

  // 两轮构建各自完整执行，hvigor 构建与测试命令都指向 ohos 宿主。
  assert.equal(steps.filter((step) => step.command === "ohpm install").length, 2);
  const cleanSteps = steps.filter((step) => step.command.includes("clean"));
  assert.deepEqual(
    cleanSteps.map((step) => step.cwd),
    [ohosProject, ohosProject],
  );
  const aaTestSteps = steps.filter((step) => step.command.includes("aa test"));
  assert.equal(aaTestSteps.length, 2);
  for (const step of aaTestSteps) {
    assert.match(step.command, /-b org\.flutter\.case/);
    assert.match(step.command, /-s class FlutterSmSuite/);
  }
});

test("loadExecutionConfig re-points flutter projects at the ohos host", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohostest-flutter-config-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const flutterRoot = await makeFlutterProject(root);
  const machineConfigPath = await writeMachineConfig(root);

  const config = await loadExecutionConfig({
    project: flutterRoot,
    machineConfigPath,
    platform: "flutter",
  });

  assert.equal(config.project, path.join(flutterRoot, "ohos"));
  assert.equal(config.flutter?.root, flutterRoot);
  assert.equal(config.bundleName, "org.flutter.case");
});

test("loadExecutionConfig rejects flutter projects without an ohos host", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohostest-flutter-empty-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const machineConfigPath = await writeMachineConfig(root);
  await fs.mkdir(path.join(root, "not-flutter"), { recursive: true });

  await assert.rejects(
    loadExecutionConfig({
      project: path.join(root, "not-flutter"),
      machineConfigPath,
      platform: "flutter",
    }),
    /case_flutter_ohos_missing/,
  );
});

test("flutter Case runs pub get each round even when the dart tool config exists", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohostest-flutter-warm-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const flutterRoot = await makeFlutterProject(root);
  await fs.mkdir(path.join(flutterRoot, ".dart_tool"), { recursive: true });
  await fs.writeFile(
    path.join(flutterRoot, ".dart_tool", "package_config.json"),
    "{}",
    "utf-8",
  );
  const flutterSdk = await makeFakeFlutterSdk(root);
  const caseDir = await writeFlutterCase(root, "flutter");
  const machineConfigPath = await writeMachineConfig(root, flutterSdk);

  const steps: Array<{ command: string; cwd: string }> = [];
  const result = await runOhosTestCase({
    caseDir,
    machineConfigPath,
    out: path.join(root, "runs"),
    runMode: "all",
    patchCommandExecutor: async (command, cwd) => {
      steps.push({ command, cwd });
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
    },
    commandExecutor: async (command, cwd) => {
      steps.push({ command, cwd });
      return fakeCommandResult(command);
    },
  });

  assert.equal(result.status, "completed");
  // golden_patch 可能新增 Dart 依赖，pub get 不做缓存跳过，每轮执行。
  assert.equal(
    steps.filter((step) => step.command.endsWith(" pub get")).length,
    2,
  );
});

test("flutter platform rejects a project without an ohos host", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohostest-flutter-bad-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  // base 是原生鸿蒙工程（hvigorfile.ts 在根、无 ohos/），与 flutter 声明不符。
  const base = path.join(root, "base");
  await fs.mkdir(base, { recursive: true });
  await fs.writeFile(path.join(base, "hvigorfile.ts"), "", "utf-8");
  await fs.mkdir(path.join(base, "entry"), { recursive: true });
  const caseDir = await writeFlutterCase(root, "flutter");
  const machineConfigPath = await writeMachineConfig(root);

  const result = await runOhosTestCase({
    caseDir,
    machineConfigPath,
    out: path.join(root, "runs"),
    runMode: "answer",
  });

  assert.equal(result.status, "failed");
  assert.match(result.diagnostics.join("\n"), /case_flutter_project_invalid/);
});

test("flutter Case keeps a shipped local.properties untouched", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohostest-flutter-prop-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const flutterRoot = await makeFlutterProject(root);
  const shipped = "flutter.sdk=E:/case-shipped-sdk\n";
  await fs.writeFile(
    path.join(flutterRoot, "ohos", "local.properties"),
    shipped,
    "utf-8",
  );
  const flutterSdk = await makeFakeFlutterSdk(root);
  const caseDir = await writeFlutterCase(root, "flutter");
  const machineConfigPath = await writeMachineConfig(root, flutterSdk);
  const steps: Array<{ command: string; cwd: string }> = [];

  const result = await runOhosTestCase({
    caseDir,
    machineConfigPath,
    out: path.join(root, "runs"),
    runMode: "answer",
    patchCommandExecutor: async (command, cwd) => {
      steps.push({ command, cwd });
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
    },
    commandExecutor: async (command, cwd) => {
      steps.push({ command, cwd });
      return fakeCommandResult(command);
    },
  });

  assert.equal(result.status, "completed");
  const properties = await fs.readFile(
    path.join(flutterRoot, "ohos", "local.properties"),
    "utf-8",
  );
  assert.equal(properties, shipped);
  // pub get / junction 仍使用 machine.json 配置的 SDK。
  const pubGet = steps.find((step) => step.command.endsWith(" pub get"));
  assert.ok(pubGet, "expected a flutter pub get step");
  assert.ok(pubGet.command.includes(path.join(flutterSdk, "bin")));
});

test("flutter layout is detected structurally without a platform field", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohostest-flutter-auto-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await makeFlutterProject(root);
  const flutterSdk = await makeFakeFlutterSdk(root);
  const caseDir = await writeFlutterCase(root);
  const machineConfigPath = await writeMachineConfig(root, flutterSdk);
  const steps: Array<{ command: string; cwd: string }> = [];

  const result = await runOhosTestCase({
    caseDir,
    machineConfigPath,
    out: path.join(root, "runs"),
    runMode: "answer",
    patchCommandExecutor: async (command, cwd) => {
      steps.push({ command, cwd });
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
    },
    commandExecutor: async (command, cwd) => {
      steps.push({ command, cwd });
      return fakeCommandResult(command);
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.metadata.platform, undefined);
  const ohpm = steps.find((step) => step.command === "ohpm install");
  assert.ok(ohpm, "expected an ohpm install step");
  assert.equal(ohpm.cwd, path.join(root, "runs", "work", "project", "ohos"));
});

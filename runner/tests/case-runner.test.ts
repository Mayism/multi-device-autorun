import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runOhosTestCase } from "../src/index.js";
import { parseJson5ish } from "../src/execution/project/json5ish.js";

async function makeProject(root: string): Promise<string> {
  const project = path.join(root, "base");
  await fs.mkdir(path.join(project, "AppScope"), { recursive: true });
  await fs.writeFile(
    path.join(project, "AppScope", "app.json5"),
    JSON.stringify({ app: { bundleName: "zhsc.1.xxxxxx" } }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(project, "build-profile.json5"),
    JSON.stringify({
      app: { products: [{ name: "default" }] },
      modules: [{ name: "entry", srcPath: "./products/entry" }],
    }),
    "utf-8",
  );
  await fs.mkdir(
    path.join(project, "products", "entry", "src", "main", "ets"),
    { recursive: true },
  );
  await fs.writeFile(
    path.join(project, "products", "entry", "hvigorfile.ts"),
    "import { hapTasks } from '@ohos/hvigor-ohos-plugin';\nexport default { system: hapTasks, plugins: [] };\n",
    "utf-8",
  );
  await fs.writeFile(
    path.join(project, "products", "entry", "src", "main", "ets", "Index.ets"),
    "export const state = 'base';\n",
    "utf-8",
  );
  await fs.writeFile(
    path.join(project, "products", "entry", "src", "main", "module.json5"),
    JSON.stringify({ module: { name: "entry", deviceTypes: ["phone"] } }),
    "utf-8",
  );
  await fs.mkdir(path.join(project, "products", "entry", "src", "ohosTest"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(project, "products", "entry", "src", "ohosTest", "module.json5"),
    JSON.stringify({ module: { name: "entry_test" } }),
    "utf-8",
  );
  await fs.mkdir(
    path.join(project, "products/entry/build/default/outputs/default"),
    { recursive: true },
  );
  await fs.mkdir(
    path.join(project, "products/entry/build/default/outputs/ohosTest"),
    { recursive: true },
  );
  await fs.writeFile(
    path.join(
      project,
      "products/entry/build/default/outputs/default/entry-default-unsigned.hap",
    ),
    "",
    "utf-8",
  );
  await fs.writeFile(
    path.join(
      project,
      "products/entry/build/default/outputs/ohosTest/entry-ohosTest-unsigned.hap",
    ),
    "",
    "utf-8",
  );
  return project;
}

async function writeMachineConfig(
  root: string,
  options: { foldServerScript?: string; hdc?: string } = {},
): Promise<string> {
  const machineConfigPath = path.join(root, "machine.json");
  await fs.writeFile(
    machineConfigPath,
    JSON.stringify({
      paths: {
        hdc: options.hdc ?? "/fake/hdc",
        hvigorw: "/fake/hvigorw",
        emulatorBin: "/fake/Emulator",
        emulatorDeployedDir: "/fake/deployed",
        ...(options.foldServerScript
          ? { foldServerScript: options.foldServerScript }
          : {}),
      },
      devices: [
        {
          id: "phone",
          target: "127.0.0.1:15001",
          testSuites: ["MachineSuite"],
          ...(options.foldServerScript ? { foldControl: true } : {}),
        },
      ],
    }),
    "utf-8",
  );
  return machineConfigPath;
}

async function writeCase(root: string): Promise<string> {
  const caseDir = path.join(root, "case");
  await fs.mkdir(caseDir, { recursive: true });
  await fs.writeFile(
    path.join(caseDir, "metadata.json"),
    JSON.stringify({
      case_id: "responsive-repeat-layout",
      base_project: "base",
      test_patch: "test_patch.patch",
      golden_patch: "golden_patch.patch",
      test_case_timeout_ms: 30000,
      fail_to_pass: ["should_adapt"],
      pass_to_pass: ["should_launch"],
      device_test_suites: {
        phone: [
          {
            suite: "MetadataSuite",
            file: "products/entry/src/ohosTest/ets/test/Metadata.test.ets",
          },
        ],
      },
    }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(caseDir, "test_patch.patch"),
    [
      "diff --git a/products/entry/src/main/ets/TestOnly.ets b/products/entry/src/main/ets/TestOnly.ets",
      "new file mode 100644",
      "index 0000000..8f0b6af",
      "--- /dev/null",
      "+++ b/products/entry/src/main/ets/TestOnly.ets",
      "@@ -0,0 +1 @@",
      "+export const testOnly = true;",
      "",
    ].join("\n"),
    "utf-8",
  );
  await fs.writeFile(
    path.join(caseDir, "golden_patch.patch"),
    [
      "diff --git a/products/entry/src/main/ets/Index.ets b/products/entry/src/main/ets/Index.ets",
      "index 2e5ab31..43d9d25 100644",
      "--- a/products/entry/src/main/ets/Index.ets",
      "+++ b/products/entry/src/main/ets/Index.ets",
      "@@ -1 +1 @@",
      "-export const state = 'base';",
      "+export const state = 'answer';",
      "",
    ].join("\n"),
    "utf-8",
  );
  return caseDir;
}

async function writeEnabledDevicesCase(root: string): Promise<string> {
  const caseDir = path.join(root, "case");
  await fs.mkdir(caseDir, { recursive: true });
  await fs.writeFile(
    path.join(caseDir, "metadata.json"),
    JSON.stringify({
      case_id: "responsive-repeat-layout",
      base_project: "base",
      test_patch: "test_patch.patch",
      golden_patch: "golden_patch.patch",
      fail_to_pass: ["should_adapt"],
      pass_to_pass: ["should_launch"],
      enabled_devices: ["phone"],
    }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(caseDir, "test_patch.patch"),
    [
      "diff --git a/products/entry/src/main/ets/TestOnly.ets b/products/entry/src/main/ets/TestOnly.ets",
      "new file mode 100644",
      "index 0000000..8f0b6af",
      "--- /dev/null",
      "+++ b/products/entry/src/main/ets/TestOnly.ets",
      "@@ -0,0 +1 @@",
      "+export const testOnly = true;",
      "",
    ].join("\n"),
    "utf-8",
  );
  await fs.writeFile(
    path.join(caseDir, "golden_patch.patch"),
    [
      "diff --git a/products/entry/src/main/ets/Index.ets b/products/entry/src/main/ets/Index.ets",
      "index 2e5ab31..43d9d25 100644",
      "--- a/products/entry/src/main/ets/Index.ets",
      "+++ b/products/entry/src/main/ets/Index.ets",
      "@@ -1 +1 @@",
      "-export const state = 'base';",
      "+export const state = 'answer';",
      "",
    ].join("\n"),
    "utf-8",
  );
  return caseDir;
}

async function makeMultiHapProject(root: string): Promise<string> {
  const project = path.join(root, "base");
  await fs.mkdir(path.join(project, "AppScope"), { recursive: true });
  await fs.writeFile(
    path.join(project, "AppScope", "app.json5"),
    JSON.stringify({ app: { bundleName: "case.multi.setting" } }),
    "utf-8",
  );
  const modules = [
    { name: "multisettingdefaultsample", srcPath: "products/default" },
    { name: "multisettingpcsample", srcPath: "products/pc" },
  ];
  await fs.writeFile(
    path.join(project, "build-profile.json5"),
    JSON.stringify({
      app: { products: [{ name: "default" }] },
      modules: modules.map((module) => ({
        name: module.name,
        srcPath: `./${module.srcPath}`,
      })),
    }),
    "utf-8",
  );
  for (const module of modules) {
    const moduleRoot = path.join(project, module.srcPath);
    await fs.mkdir(path.join(moduleRoot, "src", "main", "ets"), {
      recursive: true,
    });
    await fs.mkdir(path.join(moduleRoot, "src", "ohosTest"), {
      recursive: true,
    });
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
      JSON.stringify({
        module: {
          name: module.name,
          deviceTypes:
            module.name === "multisettingpcsample"
              ? ["2in1"]
              : ["phone", "tablet"],
        },
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(moduleRoot, "src", "ohosTest", "module.json5"),
      JSON.stringify({ module: { name: `${module.name}_test` } }),
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
        `${module.name}-default-unsigned.hap`,
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
        `${module.name}-ohosTest-unsigned.hap`,
      ),
      "",
      "utf-8",
    );
  }
  return project;
}

async function writeMultiHapMachineConfig(root: string): Promise<string> {
  const machineConfigPath = path.join(root, "machine.json");
  const deviceIds = ["phone", "wide_fold", "foldable", "tablet", "pc"];
  await fs.writeFile(
    machineConfigPath,
    JSON.stringify({
      paths: {
        hdc: "/fake/hdc",
        hvigorw: "/fake/hvigorw",
        emulatorBin: "/fake/Emulator",
        emulatorDeployedDir: "/fake/deployed",
      },
      devices: deviceIds.map((id, index) => ({
        id,
        target: `127.0.0.1:${15001 + index}`,
      })),
    }),
    "utf-8",
  );
  return machineConfigPath;
}

async function writeMultiHapCase(root: string): Promise<string> {
  const caseDir = path.join(root, "case");
  await fs.mkdir(caseDir, { recursive: true });
  const deviceSuites = Object.fromEntries(
    ["phone", "wide_fold", "foldable", "tablet", "pc"].map((device) => [
      device,
      [{ suite: `${device}_suite` }],
    ]),
  );
  await fs.writeFile(
    path.join(caseDir, "metadata.json"),
    JSON.stringify({
      case_id: "case-navigation-settings",
      base_project: "base",
      test_patch: "test_patch.patch",
      golden_patch: "golden_patch.patch",
      device_hap_modules: {
        phone: "multisettingdefaultsample",
        tablet: "multisettingdefaultsample",
        pc: "multisettingpcsample",
      },
      device_test_suites: deviceSuites,
    }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(caseDir, "test_patch.patch"),
    [
      "diff --git a/products/default/src/main/ets/TestOnly.ets b/products/default/src/main/ets/TestOnly.ets",
      "new file mode 100644",
      "index 0000000..8f0b6af",
      "--- /dev/null",
      "+++ b/products/default/src/main/ets/TestOnly.ets",
      "@@ -0,0 +1 @@",
      "+export const testOnly = true;",
      "",
    ].join("\n"),
    "utf-8",
  );
  await fs.writeFile(path.join(caseDir, "golden_patch.patch"), "", "utf-8");
  return caseDir;
}

test("runOhosTestCase groups five devices into two HAP module runs", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ohostest-case-runner-multi-hap-"),
  );
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await makeMultiHapProject(root);
  const caseDir = await writeMultiHapCase(root);
  const machineConfigPath = await writeMultiHapMachineConfig(root);
  const out = path.join(root, "runs");
  const commands: string[] = [];

  const result = await runOhosTestCase({
    caseDir,
    machineConfigPath,
    out,
    runMode: "swe",
    commandExecutor: async (command) => {
      commands.push(command);
      return {
        stdout: command.includes("aa test")
          ? "OHOS_REPORT_RESULT: stream=Tests run: 1, Failure: 0, Error: 0, Pass: 1, Ignore: 0\nOHOS_REPORT_CODE: 0\n"
          : command.includes("list targets")
            ? [15001, 15002, 15003, 15004, 15005]
                .map((port) => `127.0.0.1:${port}\tConnected`)
                .join("\n")
            : "",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      };
    },
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(
    result.runs.swe?.devices.map((device) => device.id),
    ["phone", "wide_fold", "foldable", "tablet", "pc"],
  );
  assert.deepEqual(
    result.runs.swe?.module_runs?.map((moduleRun) => ({
      module: moduleRun.module,
      devices: moduleRun.devices.map((device) => device.id),
    })),
    [
      {
        module: "multisettingdefaultsample",
        devices: ["phone", "wide_fold", "foldable", "tablet"],
      },
      { module: "multisettingpcsample", devices: ["pc"] },
    ],
  );
  assert.deepEqual(result.metadata.deviceHapModules, {
    phone: "multisettingdefaultsample",
    tablet: "multisettingdefaultsample",
    pc: "multisettingpcsample",
  });
  assert.equal(
    commands.filter((command) =>
      command.includes("module=multisettingdefaultsample@ohosTest"),
    ).length,
    1,
  );
  assert.equal(
    commands.filter((command) =>
      command.includes("module=multisettingpcsample@ohosTest"),
    ).length,
    1,
  );
  assert.ok(
    commands.some(
      (command) =>
        command.includes("aa test") &&
        command.includes("-m multisettingdefaultsample_test"),
    ),
  );
  assert.ok(
    commands.some(
      (command) =>
        command.includes("aa test") &&
        command.includes("-m multisettingpcsample_test"),
    ),
  );
  assert.ok(
    await fs.readFile(
      path.join(
        out,
        "swe",
        "modules",
        "multisettingdefaultsample",
        "result.json",
      ),
      "utf-8",
    ),
  );
  assert.ok(
    await fs.readFile(
      path.join(
        out,
        "swe",
        "modules",
        "multisettingpcsample",
        "result.json",
      ),
      "utf-8",
    ),
  );
  const summary = await fs.readFile(path.join(out, "summary.md"), "utf-8");
  assert.match(summary, /multisettingdefaultsample/);
  assert.match(summary, /multisettingpcsample/);
});

test("runOhosTestCase applies test and golden patches, runs swe and answer, and writes a case report", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ohostest-case-runner-"),
  );
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await makeProject(root);
  const caseDir = await writeCase(root);
  const machineConfigPath = await writeMachineConfig(root, {
    foldServerScript: path.resolve("src/fold/assets/fold-server.py"),
    hdc: "/fake/hdc-case-all",
  });
  const out = path.join(root, "runs", "result");
  const commands: string[] = [];

  const result = await runOhosTestCase({
    caseDir,
    machineConfigPath,
    out,
    runMode: "all",
    keepWorkdir: true,
    commandExecutor: async (command) => {
      commands.push(command);
      return {
        stdout:
          command.includes(" rport ") || command.includes(" fport rm ")
            ? "OK"
            : command.endsWith("fport ls")
              ? "[Empty]"
              : command.includes("aa test")
                ? "OHOS_REPORT_RESULT: stream=Tests run: 1, Failure: 0, Error: 0, Pass: 1, Ignore: 0\nOHOS_REPORT_CODE: 0\n"
                : command.includes("list targets")
                  ? "127.0.0.1:15001\tConnected\n"
                  : "",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      };
    },
  });

  assert.equal(result.schemaVersion, "ohostest-case-v1");
  assert.equal(result.status, "completed");
  assert.equal(result.runs.swe?.status, "completed");
  assert.equal(result.runs.answer?.status, "completed");
  assert.ok(result.artifacts.sweResult);
  assert.ok(result.artifacts.answerResult);
  assert.ok(await fs.readFile(path.join(out, "result.json"), "utf-8"));
  assert.match(
    await fs.readFile(path.join(out, "summary.md"), "utf-8"),
    /responsive-repeat-layout/,
  );
  assert.equal(
    result.artifacts.result,
    path.relative(caseDir, path.join(out, "result.json")),
  );
  assert.equal(
    result.artifacts.sweResult,
    path.relative(caseDir, path.join(out, "swe", "result.json")),
  );
  assert.equal(result.artifacts.commandLog, "commands.jsonl");
  assert.equal(
    commands.filter((command) => command.includes("aa test")).length,
    2,
  );
  assert.equal(
    commands.filter((command) => command.includes(" rport ")).length,
    2,
  );
  assert.equal(
    commands.filter((command) => command.includes(" fport rm ")).length,
    2,
  );
  assert.equal(
    commands.filter((command) => command === "ohpm install").length,
    2,
  );
  assert.ok(commands.every((command) => !command.includes("MachineSuite")));
  assert.equal(
    commands.filter((command) => command.includes("-s class MetadataSuite"))
      .length,
    2,
  );
  assert.match(commands.join("\n"), /-s timeout 30000 -w 120000/);
  assert.equal(result.metadata.testCaseTimeoutMs, 30000);
  assert.equal(result.runs.swe?.artifacts.commandLog, "../commands.jsonl");
  assert.equal(result.runs.answer?.artifacts.commandLog, "../commands.jsonl");
  assert.equal(result.artifacts.workdir, path.join(caseDir, "work"));
  assert.ok(
    result.runs.swe?.devices.every(
      (device) => device.log === "../commands.jsonl",
    ),
  );
  const logEvents = (
    await fs.readFile(path.join(out, "commands.jsonl"), "utf-8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(logEvents.some((event) => event.phase === "case"));
  assert.ok(logEvents.some((event) => event.phase === "swe"));
  assert.ok(logEvents.some((event) => event.phase === "answer"));
  assert.match(
    await fs.readFile(
      path.join(
        result.artifacts.workdir ?? "",
        "products/entry/src/main/ets/Index.ets",
      ),
      "utf-8",
    ),
    /answer/,
  );
  assert.match(
    await fs.readFile(
      path.join(root, "base/products/entry/src/main/ets/Index.ets"),
      "utf-8",
    ),
    /base/,
  );
});

test("runOhosTestCase defaults to answer run only", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ohostest-case-runner-answer-"),
  );
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await makeProject(root);
  const caseDir = await writeCase(root);
  const machineConfigPath = await writeMachineConfig(root);
  const out = path.join(root, "runs");
  const commands: string[] = [];
  const buildDeviceTypes: string[][] = [];

  const result = await runOhosTestCase({
    caseDir,
    machineConfigPath,
    out,
    keepWorkdir: true,
    commandExecutor: async (command, cwd) => {
      commands.push(command);
      if (command.includes("assembleApp")) {
        const config = parseJson5ish(
          await fs.readFile(
            path.join(cwd, "products/entry/src/main/module.json5"),
            "utf-8",
          ),
        ) as { module: { deviceTypes: string[] } };
        buildDeviceTypes.push(config.module.deviceTypes);
      }
      return {
        stdout: command.includes("aa test")
          ? "OHOS_REPORT_RESULT: stream=Tests run: 1, Failure: 0, Error: 0, Pass: 1, Ignore: 0\nOHOS_REPORT_CODE: 0\n"
          : command.includes("list targets")
            ? "127.0.0.1:15001\tConnected\n"
            : "",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      };
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.runs.swe, undefined);
  assert.equal(result.runs.answer?.status, "completed");
  assert.equal(result.artifacts.sweResult, undefined);
  assert.ok(result.artifacts.answerResult);
  assert.equal(result.artifacts.workdir, path.join(caseDir, "work"));
  assert.equal(
    commands.filter((command) => command.includes("aa test")).length,
    1,
  );
  assert.equal(
    commands.filter((command) => command === "ohpm install").length,
    1,
  );
  assert.deepEqual(buildDeviceTypes, [["phone"]]);
  assert.match(
    await fs.readFile(
      path.join(
        result.artifacts.workdir ?? "",
        "products/entry/src/main/ets/Index.ets",
      ),
      "utf-8",
    ),
    /answer/,
  );
  assert.match(
    await fs.readFile(path.join(out, "summary.md"), "utf-8"),
    /\| swe \| not run \|/,
  );
  assert.match(
    await fs.readFile(
      path.join(root, "base/products/entry/src/main/ets/Index.ets"),
      "utf-8",
    ),
    /base/,
  );
});

test("runOhosTestCase uses enabled devices for full test runs", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ohostest-case-runner-enabled-"),
  );
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await makeProject(root);
  const caseDir = await writeEnabledDevicesCase(root);
  const machineConfigPath = await writeMachineConfig(root);
  const commands: string[] = [];

  const result = await runOhosTestCase({
    caseDir,
    machineConfigPath,
    out: path.join(root, "runs"),
    runMode: "all",
    commandExecutor: async (command) => {
      commands.push(command);
      return {
        stdout: command.includes("aa test")
          ? "OHOS_REPORT_RESULT: stream=Tests run: 1, Failure: 0, Error: 0, Pass: 1, Ignore: 0\nOHOS_REPORT_CODE: 0\n"
          : command.includes("list targets")
            ? "127.0.0.1:15001\tConnected\n"
            : "",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      };
    },
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(
    result.runs.swe?.devices.map((device) => device.id),
    ["phone"],
  );
  assert.equal(
    commands.filter((command) => command.includes("aa test")).length,
    2,
  );
  assert.ok(commands.every((command) => !command.includes("-s class")));
  assert.ok(commands.every((command) => !command.includes("MachineSuite")));
  await assert.rejects(fs.stat(path.join(caseDir, "work")), /ENOENT/);
});

test("runOhosTestCase writes case command log when golden patch fails before answer run", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ohostest-case-patch-failure-log-"),
  );
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await makeProject(root);
  const caseDir = await writeCase(root);
  await fs.writeFile(
    path.join(caseDir, "golden_patch.patch"),
    [
      "diff --git a/products/entry/src/main/ets/TestOnly.ets b/products/entry/src/main/ets/TestOnly.ets",
      "new file mode 100644",
      "index 0000000..8f0b6af",
      "--- /dev/null",
      "+++ b/products/entry/src/main/ets/TestOnly.ets",
      "@@ -0,0 +1 @@",
      "+export const duplicate = true;",
      "",
    ].join("\n"),
    "utf-8",
  );
  const machineConfigPath = await writeMachineConfig(root);
  const out = path.join(root, "runs");

  const result = await runOhosTestCase({
    caseDir,
    machineConfigPath,
    out,
    runMode: "all",
    keepWorkdir: true,
    commandExecutor: async (command) => ({
      stdout: command.includes("aa test")
        ? "OHOS_REPORT_RESULT: stream=Tests run: 1, Failure: 0, Error: 0, Pass: 1, Ignore: 0\nOHOS_REPORT_CODE: 0\n"
        : command.includes("list targets")
          ? "127.0.0.1:15001\tConnected\n"
          : "",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    }),
  });

  const commandLog = await fs.readFile(
    path.join(out, "commands.jsonl"),
    "utf-8",
  );
  const summary = await fs.readFile(path.join(out, "summary.md"), "utf-8");

  assert.equal(result.status, "failed");
  assert.ok(result.runs.swe);
  assert.equal(result.runs.answer, undefined);
  assert.equal(result.artifacts.commandLog, "commands.jsonl");
  assert.match(commandLog, /git apply --ignore-whitespace --check/);
  assert.match(commandLog, /golden_patch\.patch/);
  assert.match(commandLog, /"exitCode":[1-9]/);
  assert.match(commandLog, /"stderr":".+"/s);
  assert.match(summary, /patch_apply_failed: golden_patch/);
  assert.match(summary, /Command Log: commands\.jsonl/);
  assert.doesNotMatch(summary, /"stderr":/);
});

test("runOhosTestCase temporarily enables tablet only for swe", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ohostest-case-device-filter-"),
  );
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await makeProject(root);
  const caseDir = await writeCase(root);
  await fs.writeFile(
    path.join(caseDir, "metadata.json"),
    JSON.stringify({
      case_id: "responsive-repeat-layout",
      base_project: "base",
      test_patch: "test_patch.patch",
      golden_patch: "golden_patch.patch",
      fail_to_pass: ["should_adapt"],
      pass_to_pass: ["should_launch"],
      device_test_suites: {
        phone: [{ suite: "PhoneSuite" }],
        tablet: [{ suite: "TabletSuite" }],
      },
    }),
    "utf-8",
  );
  const machineConfigPath = await writeMachineConfig(root);
  await fs.writeFile(
    machineConfigPath,
    JSON.stringify({
      paths: {
        hdc: "/fake/hdc",
        hvigorw: "/fake/hvigorw",
        emulatorBin: "/fake/Emulator",
        emulatorDeployedDir: "/fake/deployed",
      },
      devices: [
        { id: "phone", target: "127.0.0.1:15001" },
        { id: "tablet", target: "127.0.0.1:15003" },
      ],
    }),
    "utf-8",
  );
  const commands: string[] = [];
  const buildDeviceTypes: string[][] = [];
  const out = path.join(root, "runs");

  const result = await runOhosTestCase({
    caseDir,
    machineConfigPath,
    out,
    runMode: "all",
    devices: ["tablet"],
    keepWorkdir: true,
    commandExecutor: async (command, cwd) => {
      commands.push(command);
      if (command.includes("assembleApp")) {
        const config = parseJson5ish(
          await fs.readFile(
            path.join(cwd, "products/entry/src/main/module.json5"),
            "utf-8",
          ),
        ) as { module: { deviceTypes: string[] } };
        buildDeviceTypes.push(config.module.deviceTypes);
      }
      return {
        stdout: command.includes("aa test")
          ? "OHOS_REPORT_RESULT: stream=Tests run: 1, Failure: 0, Error: 0, Pass: 1, Ignore: 0\nOHOS_REPORT_CODE: 0\n"
          : command.includes("list targets")
            ? "127.0.0.1:15001\tConnected\n127.0.0.1:15003\tConnected\n"
            : "",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      };
    },
  });

  assert.deepEqual(
    result.runs.swe?.devices.map((device) => device.id),
    ["tablet"],
  );
  assert.deepEqual(
    result.runs.answer?.devices.map((device) => device.id),
    ["tablet"],
  );
  assert.equal(
    commands.filter((command) => command.includes("-s class TabletSuite"))
      .length,
    2,
  );
  assert.ok(commands.every((command) => !command.includes("PhoneSuite")));
  assert.deepEqual(buildDeviceTypes, [["phone", "tablet"], ["phone"]]);
  const finalConfig = parseJson5ish(
    await fs.readFile(
      path.join(caseDir, "work/products/entry/src/main/module.json5"),
      "utf-8",
    ),
  ) as { module: { deviceTypes: string[] } };
  assert.deepEqual(finalConfig.module.deviceTypes, ["phone"]);
});

test("runOhosTestCase writes configuration failures to result and command log", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ohostest-case-config-error-"),
  );
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await makeProject(root);
  const caseDir = await writeCase(root);
  const machineConfigPath = await writeMachineConfig(root);
  const out = path.join(root, "runs");
  await fs.writeFile(
    path.join(root, "base", "build-profile.json5"),
    "{ invalid",
    "utf-8",
  );

  const result = await runOhosTestCase({
    caseDir,
    machineConfigPath,
    out,
    keepWorkdir: true,
  });
  const persistedResult = await fs.readFile(
    path.join(out, "result.json"),
    "utf-8",
  );
  const commandLog = await fs.readFile(
    path.join(out, "commands.jsonl"),
    "utf-8",
  );

  assert.equal(result.status, "failed");
  assert.match(result.diagnostics[0] ?? "", /build-profile\.json5/);
  assert.match(persistedResult, /config_file_parse_failed/);
  assert.match(commandLog, /"event":"runner_error"/);
  assert.match(commandLog, /"errorCode":"CONFIG_PARSE_ERROR"/);
  assert.match(commandLog, /config_file_parse_failed/);
  assert.match(commandLog, /build-profile\.json5/);
});

test("runOhosTestCase logs metadata failures before context creation", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ohostest-case-metadata-error-"),
  );
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const caseDir = path.join(root, "case");
  const out = path.join(root, "runs");
  await fs.mkdir(caseDir, { recursive: true });
  await fs.writeFile(path.join(caseDir, "metadata.json"), "{ invalid", "utf-8");

  const result = await runOhosTestCase({ caseDir, out });
  assert.equal(result.status, "failed");
  const commandLog = await fs.readFile(
    path.join(out, "commands.jsonl"),
    "utf-8",
  );
  assert.match(commandLog, /"event":"runner_error"/);
  assert.match(commandLog, /"errorCode":"CONFIG_PARSE_ERROR"/);
  assert.match(commandLog, /metadata\.json/);
  assert.match(
    await fs.readFile(path.join(out, "result.json"), "utf-8"),
    /config_file_parse_failed/,
  );
});

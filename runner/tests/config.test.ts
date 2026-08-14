import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadMatrixConfig } from "../src/matrix/config.js";
import { AA_TEST_CASE_TIMEOUT_MS } from "../src/execution/ohostest.js";

async function makeTempProject(t: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohostest-config-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, "hvigorw"), "#!/bin/sh\n", "utf-8");
  await fs.mkdir(path.join(root, "AppScope"), { recursive: true });
  await fs.writeFile(
    path.join(root, "AppScope", "app.json5"),
    `{
      "app": {
        // json5 comments are common in HarmonyOS config files
        "bundleName": "zhsc.1.xxxxxx"
      }
    }\n`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(root, "build-profile.json5"),
    JSON.stringify({
      app: { products: [{ name: "default" }] },
      modules: [{ name: "entry", srcPath: "./products/entry" }],
    }),
    "utf-8",
  );
  await fs.mkdir(path.join(root, "products", "entry", "src", "ohosTest"), {
    recursive: true,
  });
  await fs.mkdir(path.join(root, "products", "entry", "src", "main"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(root, "products", "entry", "hvigorfile.ts"),
    "import { hapTasks } from '@ohos/hvigor-ohos-plugin';\nexport default { system: hapTasks, plugins: [] };\n",
    "utf-8",
  );
  await fs.writeFile(
    path.join(root, "products", "entry", "src", "main", "module.json5"),
    JSON.stringify({ module: { name: "entry", type: "entry" } }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(root, "products", "entry", "src", "ohosTest", "module.json5"),
    JSON.stringify({ module: { name: "entry_test" } }),
    "utf-8",
  );
  return root;
}

async function writeMachineConfig(project: string): Promise<string> {
  const machineConfigPath = path.join(project, "machine.json");
  await fs.writeFile(
    machineConfigPath,
    JSON.stringify({
      paths: {
        hvigorw: "hvigorw",
        hdc: "hdc",
        emulatorBin: "Emulator",
        emulatorDeployedDir: "/fake/deployed",
      },
      devices: [
        {
          id: "phone",
          target: "127.0.0.1:15001",
          profile: "Mate 80 Pro",
          hdcPort: 15001,
        },
      ],
    }),
    "utf-8",
  );
  return machineConfigPath;
}

test("loadMatrixConfig infers project information and reads machine devices", async (t) => {
  const project = await makeTempProject(t);
  const machineConfigPath = await writeMachineConfig(project);

  const config = await loadMatrixConfig({ project, machineConfigPath });

  assert.equal(config.product, "default");
  assert.equal(config.module, "entry");
  assert.deepEqual(config.sharedModules, []);
  assert.equal(config.bundleName, "zhsc.1.xxxxxx");
  assert.equal(config.testModule, "entry_test");
  assert.equal(config.testRunner, "OpenHarmonyTestRunner");
  assert.equal(config.paths.hvigorw, "hvigorw");
  assert.equal(config.paths.hdc, "hdc");
  assert.equal(config.paths.emulatorBin, "Emulator");
  assert.equal(config.paths.emulatorDeployedDir, "/fake/deployed");
  assert.equal(config.timeoutMs, 120000);
  assert.equal(config.testCaseTimeoutMs, AA_TEST_CASE_TIMEOUT_MS);
  assert.equal(config.build.appTask, "assembleApp");
  assert.equal(config.build.testTask, "ohosTest@PackageHap");
  assert.equal(
    config.artifacts.appHap,
    path.join(
      project,
      "products/entry/build/default/outputs/default/entry-default-unsigned.hap",
    ),
  );
  assert.equal(
    config.artifacts.testHap,
    path.join(
      project,
      "products/entry/build/default/outputs/ohosTest/entry-ohosTest-unsigned.hap",
    ),
  );
  assert.equal(config.devices[0]?.hdcPort, 15001);
  assert.equal(config.devices[0]?.startEmulator, false);
});

test("loadMatrixConfig accepts an in-memory test case timeout override", async (t) => {
  const project = await makeTempProject(t);
  const machineConfigPath = await writeMachineConfig(project);

  const config = await loadMatrixConfig({
    project,
    machineConfigPath,
    testCaseTimeoutMs: 30000,
  });

  assert.equal(config.testCaseTimeoutMs, 30000);
});

test("loadMatrixConfig discovers artifacts for an explicitly selected HAP", async (t) => {
  const project = await makeTempProject(t);
  const buildProfilePath = path.join(project, "build-profile.json5");
  await fs.writeFile(
    buildProfilePath,
    JSON.stringify({
      app: { products: [{ name: "default" }] },
      modules: [
        { name: "entry", srcPath: "./products/entry" },
        { name: "pc", srcPath: "./products/pc" },
      ],
    }),
    "utf-8",
  );
  await fs.mkdir(path.join(project, "products", "pc", "src", "main"), {
    recursive: true,
  });
  await fs.mkdir(path.join(project, "products", "pc", "src", "ohosTest"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(project, "products", "pc", "hvigorfile.ts"),
    "import { hapTasks } from '@ohos/hvigor-ohos-plugin';\nexport default { system: hapTasks, plugins: [] };\n",
    "utf-8",
  );
  await fs.writeFile(
    path.join(project, "products", "pc", "src", "main", "module.json5"),
    JSON.stringify({ module: { name: "pc", type: "entry" } }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(project, "products", "pc", "src", "ohosTest", "module.json5"),
    JSON.stringify({ module: { name: "pc_test" } }),
    "utf-8",
  );
  const machineConfigPath = await writeMachineConfig(project);

  const config = await loadMatrixConfig({
    project,
    machineConfigPath,
    module: "pc",
  });

  assert.equal(config.module, "pc");
  assert.equal(config.moduleSrcPath, "products/pc");
  assert.equal(config.testModule, "pc_test");
  assert.equal(
    config.artifacts.appHap,
    path.join(
      project,
      "products/pc/build/default/outputs/default/pc-default-unsigned.hap",
    ),
  );
});

test("loadMatrixConfig accepts explicit machine paths", async (t) => {
  const project = await makeTempProject(t);
  const machineConfigPath = path.join(project, "paths.json");
  await fs.writeFile(
    machineConfigPath,
    JSON.stringify({
      paths: {
        hvigorw: "/config/hvigorw",
        ohpm: "/config/ohpm",
        hdc: "/config/hdc",
        emulatorBin: "/config/Emulator",
        emulatorDeployedDir: "/config/deployed",
      },
      devices: [{ id: "phone", target: "127.0.0.1:15001" }],
    }),
    "utf-8",
  );

  const config = await loadMatrixConfig({ project, machineConfigPath });

  assert.deepEqual(config.paths, {
    hvigorw: "/config/hvigorw",
    ohpm: "/config/ohpm",
    hdc: "/config/hdc",
    emulatorBin: "/config/Emulator",
    emulatorDeployedDir: "/config/deployed",
  });
});

test("loadMatrixConfig reads device testSuites and deduplicates suite classes", async (t) => {
  const project = await makeTempProject(t);
  const machineConfigPath = path.join(project, "suites.json");
  await fs.writeFile(
    machineConfigPath,
    JSON.stringify({
      paths: {
        hvigorw: "hvigorw",
        hdc: "hdc",
        emulatorBin: "Emulator",
        emulatorDeployedDir: "/fake/deployed",
      },
      devices: [
        {
          id: "foldable",
          target: "127.0.0.1:15002",
          testSuites: [
            "CommonPassToPassTest",
            "SmPassToPassTest",
            "MdFailToPassTest",
            "SmPassToPassTest",
          ],
        },
      ],
    }),
    "utf-8",
  );

  const config = await loadMatrixConfig({ project, machineConfigPath });

  assert.deepEqual(config.devices[0]?.testClasses, [
    "CommonPassToPassTest",
    "SmPassToPassTest",
    "MdFailToPassTest",
  ]);
});

test("loadMatrixConfig rejects legacy testFolders config and invalid testSuites", async (t) => {
  const project = await makeTempProject(t);
  const machineConfigPath = path.join(project, "bad-suites.json");

  await fs.writeFile(
    machineConfigPath,
    JSON.stringify({
      paths: {
        hvigorw: "hvigorw",
        hdc: "hdc",
        emulatorBin: "Emulator",
        emulatorDeployedDir: "/fake/deployed",
      },
      testFolders: { common: "CommonPassToPassTest" },
      devices: [{ id: "phone", target: "127.0.0.1:15001" }],
    }),
    "utf-8",
  );
  await assert.rejects(
    () => loadMatrixConfig({ project, machineConfigPath }),
    /config\.testFolders has been removed/,
  );

  await fs.writeFile(
    machineConfigPath,
    JSON.stringify({
      paths: {
        hvigorw: "hvigorw",
        hdc: "hdc",
        emulatorBin: "Emulator",
        emulatorDeployedDir: "/fake/deployed",
      },
      devices: [
        { id: "phone", target: "127.0.0.1:15001", testFolders: ["common"] },
      ],
    }),
    "utf-8",
  );
  await assert.rejects(
    () => loadMatrixConfig({ project, machineConfigPath }),
    /renamed to testSuites/,
  );

  await fs.writeFile(
    machineConfigPath,
    JSON.stringify({
      paths: {
        hvigorw: "hvigorw",
        hdc: "hdc",
        emulatorBin: "Emulator",
        emulatorDeployedDir: "/fake/deployed",
      },
      devices: [{ id: "phone", target: "127.0.0.1:15001", testSuites: [""] }],
    }),
    "utf-8",
  );
  await assert.rejects(
    () => loadMatrixConfig({ project, machineConfigPath }),
    /testSuites.*non-empty/,
  );
});

test("loadMatrixConfig rejects missing paths, empty devices, and invalid target from machine config", async (t) => {
  const project = await makeTempProject(t);
  const machineConfigPath = path.join(project, "bad.json");

  await fs.writeFile(
    machineConfigPath,
    JSON.stringify({ devices: [{ id: "phone", target: "127.0.0.1:15001" }] }),
    "utf-8",
  );
  await assert.rejects(
    () => loadMatrixConfig({ project, machineConfigPath }),
    /paths\.hvigorw/,
  );

  await fs.writeFile(
    machineConfigPath,
    JSON.stringify({
      paths: { hvigorw: "hvigorw", hdc: "hdc", emulatorBin: "Emulator" },
      devices: [{ id: "phone", target: "127.0.0.1:15001" }],
    }),
    "utf-8",
  );
  await assert.rejects(
    () => loadMatrixConfig({ project, machineConfigPath }),
    /paths\.emulatorDeployedDir/,
  );

  await fs.writeFile(
    machineConfigPath,
    JSON.stringify({
      paths: {
        hvigorw: "hvigorw",
        hdc: "hdc",
        emulatorBin: "Emulator",
        emulatorDeployedDir: "/fake/deployed",
      },
      devices: [],
    }),
    "utf-8",
  );
  await assert.rejects(
    () => loadMatrixConfig({ project, machineConfigPath }),
    /devices/,
  );

  await fs.writeFile(
    machineConfigPath,
    JSON.stringify({
      paths: {
        hvigorw: "hvigorw",
        hdc: "hdc",
        emulatorBin: "Emulator",
        emulatorDeployedDir: "/fake/deployed",
      },
      devices: [{ id: "phone", target: "not a target" }],
    }),
    "utf-8",
  );
  await assert.rejects(
    () => loadMatrixConfig({ project, machineConfigPath }),
    /target/,
  );
});

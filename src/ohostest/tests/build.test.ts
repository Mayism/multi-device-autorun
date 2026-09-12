import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runBuild } from "../src/execution/build.js";
import { shellQuote } from "../src/execution/utils/shellQuote.js";
import type { MatrixConfig } from "../src/matrix/types/index.js";

async function makeBuildConfig(t: test.TestContext): Promise<MatrixConfig> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "ohostest-build-"));
  t.after(async () => {
    await fs.rm(project, { recursive: true, force: true });
  });
  const appHap = path.join(project, "entry-default-unsigned.hap");
  const testHap = path.join(project, "entry-ohosTest-unsigned.hap");
  await fs.writeFile(appHap, "", "utf-8");
  await fs.writeFile(testHap, "", "utf-8");
  return {
    project,
    product: "default",
    module: "entry",
    moduleSrcPath: "products/entry",
    sharedModules: [],
    bundleName: "example.bundle",
    testModule: "entry_test",
    testRunner: "OpenHarmonyTestRunner",
    testCaseTimeoutMs: 15000,
    timeoutMs: 120000,
    build: {
      mode: "project",
      appTask: "assembleApp",
      testTask: "ohosTest@PackageHap",
    },
    paths: {
      hvigorw: "hvigorw",
      ohpm: "ohpm",
      hdc: "hdc",
      emulatorBin: "Emulator",
      emulatorDeployedDir: "/tmp/deployed",
    },
    artifacts: { appHap, testHap },
    devices: [],
  };
}

test("runBuild installs dependencies before clean and Hvigor builds", async (t) => {
  const config = await makeBuildConfig(t);
  const commands: string[] = [];

  const outcome = await runBuild({
    config,
    skipBuild: false,
    diagnostics: [],
    runCommand: async (command) => {
      commands.push(command);
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      };
    },
  });

  assert.deepEqual(commands, [
    "ohpm install",
    "hvigorw clean --no-daemon",
    "hvigorw --mode project -p product=default assembleApp --analyze=normal --parallel --incremental --no-daemon",
    "hvigorw --mode module -p module=entry@ohosTest ohosTest@PackageHap --no-daemon --stacktrace",
  ]);
  assert.equal(outcome.result.status, "passed");
  assert.deepEqual(outcome.installArtifacts?.hspPaths, []);
});

test("runBuild prepares the RN workspace around the Hvigor commands for rn cases", async (t) => {
  const config = await makeBuildConfig(t);
  config.rn = { root: path.join(path.dirname(config.project), "rn-root") };
  const steps: Array<{ command: string; cwd: string }> = [];

  const outcome = await runBuild({
    config,
    skipBuild: false,
    diagnostics: [],
    runCommand: async (command, cwd) => {
      steps.push({ command, cwd });
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      };
    },
  });

  const rnRoot = config.rn.root;
  const project = config.project;
  assert.deepEqual(steps, [
    { command: "npm install --force", cwd: rnRoot },
    { command: "ohpm install", cwd: project },
    {
      command:
        "npx react-native codegen-harmony --cpp-output-path ./harmony/entry/src/main/cpp/generated --rnoh-module-path ./harmony/entry/oh_modules/@rnoh/react-native-openharmony",
      cwd: rnRoot,
    },
    { command: "npx react-native bundle-harmony --dev", cwd: rnRoot },
    { command: "hvigorw clean --no-daemon", cwd: project },
    {
      command:
        "hvigorw --mode module -p product=default assembleHap --no-daemon",
      cwd: project,
    },
    {
      command:
        "hvigorw --mode module -p module=entry@ohosTest ohosTest@PackageHap --no-daemon --stacktrace",
      cwd: project,
    },
  ]);
  assert.equal(outcome.result.status, "passed");
});

test("runBuild prepends flutter pub get to the native sequence for flutter cases", async (t) => {
  const config = await makeBuildConfig(t);
  const flutterRoot = path.join(path.dirname(config.project), "flutter-root");
  config.flutter = { root: flutterRoot };
  // paths.flutter 是 SDK 根目录，命令应取其 bin 下的 flutter 可执行文件。
  config.paths.flutter = "flutter-sdk";
  const flutterBin = path.join(
    "flutter-sdk",
    "bin",
    process.platform === "win32" ? "flutter.bat" : "flutter",
  );
  const commands: string[] = [];

  const outcome = await runBuild({
    config,
    skipBuild: false,
    diagnostics: [],
    runCommand: async (command) => {
      commands.push(command);
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      };
    },
  });

  assert.deepEqual(commands, [
    `${shellQuote(flutterBin)} pub get`,
    "ohpm install",
    "hvigorw clean --no-daemon",
    "hvigorw --mode project -p product=default assembleApp --analyze=normal --parallel --incremental --no-daemon",
    "hvigorw --mode module -p module=entry@ohosTest ohosTest@PackageHap --no-daemon --stacktrace",
  ]);
  assert.equal(outcome.result.status, "passed");
});

test("runBuild stops when clean fails", async (t) => {
  const config = await makeBuildConfig(t);
  const commands: string[] = [];

  const outcome = await runBuild({
    config,
    skipBuild: false,
    diagnostics: [],
    runCommand: async (command) => {
      commands.push(command);
      return {
        stdout: "",
        stderr: command.includes(" clean ") ? "clean failed" : "",
        exitCode: command.includes(" clean ") ? 1 : 0,
        durationMs: 1,
      };
    },
  });

  assert.deepEqual(commands, ["ohpm install", "hvigorw clean --no-daemon"]);
  assert.equal(outcome.result.status, "blocked");
  assert.equal(outcome.result.blockedReason, "build_failed");
});

test("runBuild resolves unsigned HSPs in shared-module order without exposing them in BuildResult", async (t) => {
  const config = await makeBuildConfig(t);
  const commonOutput = path.join(
    config.project,
    "commons/common/build/default/outputs/default",
  );
  const stylesOutput = path.join(
    config.project,
    "commons/styles/build/default/outputs/default",
  );
  config.sharedModules = [
    {
      name: "common",
      srcPath: "commons/common",
      packageName: "common",
      dependencies: [],
      outputDir: commonOutput,
    },
    {
      name: "styles",
      srcPath: "commons/styles",
      packageName: "styles",
      dependencies: [],
      outputDir: stylesOutput,
    },
  ];
  await fs.mkdir(commonOutput, { recursive: true });
  await fs.mkdir(stylesOutput, { recursive: true });
  const commonHsp = path.join(commonOutput, "common-default-unsigned.hsp");
  const stylesHsp = path.join(stylesOutput, "styles-default-unsigned.hsp");
  await fs.writeFile(commonHsp, "", "utf-8");
  await fs.writeFile(stylesHsp, "", "utf-8");

  const outcome = await runBuild({
    config,
    skipBuild: true,
    diagnostics: [],
    runCommand: async () => {
      throw new Error("skip-build must not execute commands");
    },
  });

  assert.deepEqual(outcome.installArtifacts?.hspPaths, [commonHsp, stylesHsp]);
  assert.equal("hspPaths" in outcome.result, false);
});

test("runBuild selects signed HSPs when the configured app HAP is signed", async (t) => {
  const config = await makeBuildConfig(t);
  const signedAppHap = path.join(config.project, "entry-default-signed.hap");
  await fs.writeFile(signedAppHap, "", "utf-8");
  config.artifacts.appHap = signedAppHap;
  const outputDir = path.join(
    config.project,
    "commons/common/build/default/outputs/default",
  );
  config.sharedModules = [
    {
      name: "common",
      srcPath: "commons/common",
      packageName: "common",
      dependencies: [],
      outputDir,
    },
  ];
  await fs.mkdir(outputDir, { recursive: true });
  const signedHsp = path.join(outputDir, "common-default-signed.hsp");
  await fs.writeFile(signedHsp, "", "utf-8");
  await fs.writeFile(
    path.join(outputDir, "common-default-unsigned.hsp"),
    "",
    "utf-8",
  );

  const outcome = await runBuild({
    config,
    skipBuild: true,
    diagnostics: [],
    runCommand: async () => {
      throw new Error("skip-build must not execute commands");
    },
  });

  assert.deepEqual(outcome.installArtifacts?.hspPaths, [signedHsp]);
});

test("runBuild blocks with a diagnostic when a shared HSP is missing", async (t) => {
  const config = await makeBuildConfig(t);
  const outputDir = path.join(
    config.project,
    "commons/common/build/default/outputs/default",
  );
  config.sharedModules = [
    {
      name: "common",
      srcPath: "commons/common",
      packageName: "common",
      dependencies: [],
      outputDir,
    },
  ];
  await fs.mkdir(outputDir, { recursive: true });
  const diagnostics: string[] = [];

  const outcome = await runBuild({
    config,
    skipBuild: true,
    diagnostics,
    runCommand: async () => {
      throw new Error("skip-build must not execute commands");
    },
  });

  assert.equal(outcome.result.status, "blocked");
  assert.equal(outcome.result.blockedReason, "hap_missing");
  assert.equal(outcome.installArtifacts, undefined);
  assert.match(diagnostics.join("\n"), /common/);
  assert.match(diagnostics.join("\n"), new RegExp(outputDir));
});

test("runBuild blocks and lists ambiguous shared HSP candidates", async (t) => {
  const config = await makeBuildConfig(t);
  const outputDir = path.join(
    config.project,
    "commons/common/build/default/outputs/default",
  );
  config.sharedModules = [
    {
      name: "common",
      srcPath: "commons/common",
      packageName: "common",
      dependencies: [],
      outputDir,
    },
  ];
  await fs.mkdir(outputDir, { recursive: true });
  const first = path.join(outputDir, "common-a-unsigned.hsp");
  const second = path.join(outputDir, "common-b-unsigned.hsp");
  await fs.writeFile(first, "", "utf-8");
  await fs.writeFile(second, "", "utf-8");
  const diagnostics: string[] = [];

  const outcome = await runBuild({
    config,
    skipBuild: true,
    diagnostics,
    runCommand: async () => {
      throw new Error("skip-build must not execute commands");
    },
  });

  assert.equal(outcome.result.status, "blocked");
  assert.match(diagnostics.join("\n"), new RegExp(first));
  assert.match(diagnostics.join("\n"), new RegExp(second));
});

test("runBuild honors configured rn bundle commands in place of the default one", async (t) => {
  const config = await makeBuildConfig(t);
  config.rn = {
    root: path.join(path.dirname(config.project), "rn-root"),
    bundleCommands: ["npm run dev:basic", "npm run dev:base"],
  };
  const steps: Array<{ command: string; cwd: string }> = [];

  const outcome = await runBuild({
    config,
    skipBuild: false,
    diagnostics: [],
    runCommand: async (command, cwd) => {
      steps.push({ command, cwd });
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
    },
  });

  const rnRoot = config.rn.root;
  const project = config.project;
  assert.deepEqual(
    steps.slice(0, 5).map(({ command }) => command),
    [
      "npm install --force",
      "ohpm install",
      "npx react-native codegen-harmony --cpp-output-path ./harmony/entry/src/main/cpp/generated --rnoh-module-path ./harmony/entry/oh_modules/@rnoh/react-native-openharmony",
      "npm run dev:basic",
      "npm run dev:base",
    ],
  );
  assert.deepEqual(steps[3], { command: "npm run dev:basic", cwd: rnRoot });
  assert.deepEqual(steps[4], { command: "npm run dev:base", cwd: rnRoot });
  assert.equal(steps.length, 8);
  assert.equal(
    steps.filter((step) => step.command.includes("bundle-harmony")).length,
    0,
  );
  assert.equal(outcome.result.status, "passed");
});

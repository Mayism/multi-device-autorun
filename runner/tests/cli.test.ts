import assert from "node:assert/strict";
import test from "node:test";
import {
  parseOhosTestCaseArgs,
  parseOhosTestMatrixArgs,
} from "../src/index.js";

test("parseOhosTestMatrixArgs parses required and optional arguments", () => {
  const parsed = parseOhosTestMatrixArgs([
    "--project",
    "/tmp/project",
    "--machine-config",
    "/tmp/matrix.json",
    "--out",
    "/tmp/result.json",
    "--device",
    "phone",
    "--device",
    "tablet",
    "--test-class",
    "HomePageAdaptiveTest",
    "--skip-build",
    "true",
    "--keep-emulators",
    "false",
  ]);

  assert.deepEqual(parsed, {
    project: "/tmp/project",
    machineConfigPath: "/tmp/matrix.json",
    out: "/tmp/result.json",
    devices: ["phone", "tablet"],
    testClass: "HomePageAdaptiveTest",
    skipBuild: true,
    keepEmulators: false,
  });
});

test("parseOhosTestMatrixArgs requires only project", () => {
  assert.throws(() => parseOhosTestMatrixArgs([]), /--project/);
  assert.deepEqual(parseOhosTestMatrixArgs(["--project", "/tmp/project"]), {
    project: "/tmp/project",
  });
});

test("parseOhosTestMatrixArgs rejects removed --config alias", () => {
  assert.throws(
    () =>
      parseOhosTestMatrixArgs([
        "--project",
        "/tmp/project",
        "--config",
        "/tmp/old-project-config.json",
      ]),
    /未知参数 --config/,
  );
});

test("parseOhosTestCaseArgs parses case mode arguments", () => {
  const parsed = parseOhosTestCaseArgs([
    "--case",
    "/tmp/case",
    "--machine-config",
    "/tmp/machine.json",
    "--out",
    "/tmp/result.json",
    "--skip-build",
    "true",
    "--keep-emulators",
    "false",
    "--keep-workdir",
    "true",
    "--run",
    "swe",
  ]);

  assert.deepEqual(parsed, {
    caseDir: "/tmp/case",
    machineConfigPath: "/tmp/machine.json",
    out: "/tmp/result.json",
    skipBuild: true,
    keepEmulators: false,
    keepWorkdir: true,
    runMode: "swe",
  });
});

test("parseOhosTestCaseArgs defaults to answer run mode", () => {
  assert.deepEqual(parseOhosTestCaseArgs(["--case", "/tmp/case"]), {
    caseDir: "/tmp/case",
    runMode: "answer",
  });
});

test("parseOhosTestCaseArgs rejects unknown run mode", () => {
  assert.throws(
    () => parseOhosTestCaseArgs(["--case", "/tmp/case", "--run", "both"]),
    /--run/,
  );
});

test("parseOhosTestCaseArgs parses repeatable device filters", () => {
  assert.deepEqual(
    parseOhosTestCaseArgs([
      "--case",
      "/tmp/case",
      "--device",
      "phone",
      "--device",
      "tablet",
    ]),
    {
      caseDir: "/tmp/case",
      devices: ["phone", "tablet"],
      runMode: "answer",
    },
  );
});

test("parseOhosTestCaseArgs rejects matrix-only test class override", () => {
  assert.throws(
    () =>
      parseOhosTestCaseArgs([
        "--case",
        "/tmp/case",
        "--test-class",
        "OnlyThisSuite",
      ]),
    /未知参数 --test-class/,
  );
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildCaseExecutionGroups,
  buildCaseDeviceSelection,
  loadCaseMetadata,
} from "../src/case/config.js";
import { AA_TEST_CASE_TIMEOUT_MS } from "../src/execution/ohostest.js";
import type { MatrixConfig } from "../src/index.js";

async function makeTempCase(t: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ohostest-case-config-"),
  );
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const caseDir = path.join(root, "case");
  await fs.mkdir(caseDir, { recursive: true });
  return caseDir;
}

test("loadCaseMetadata reads metadata and resolves patch and base paths", async (t) => {
  const caseDir = await makeTempCase(t);
  await fs.mkdir(path.join(caseDir, "..", "base"), { recursive: true });
  await fs.writeFile(path.join(caseDir, "test_patch.patch"), "", "utf-8");
  await fs.writeFile(path.join(caseDir, "golden_patch.patch"), "", "utf-8");
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
        phone: [{ suite: "CommonPassToPassTest" }],
      },
      device_hap_modules: {
        phone: "multisettingdefaultsample",
        tablet: "multisettingdefaultsample",
        pc: "multisettingpcsample",
      },
    }),
    "utf-8",
  );

  const metadata = await loadCaseMetadata(caseDir);

  assert.equal(metadata.caseId, "responsive-repeat-layout");
  assert.equal(metadata.baseProject, path.resolve(caseDir, "..", "base"));
  assert.equal(metadata.testPatch, path.join(caseDir, "test_patch.patch"));
  assert.equal(metadata.goldenPatch, path.join(caseDir, "golden_patch.patch"));
  assert.equal(metadata.testCaseTimeoutMs, 30000);
  assert.ok(metadata.deviceTestSuites);
  assert.deepEqual(
    metadata.deviceTestSuites.phone?.map((suite) => suite.suite),
    ["CommonPassToPassTest"],
  );
  assert.deepEqual(metadata.deviceHapModules, {
    phone: "multisettingdefaultsample",
    tablet: "multisettingdefaultsample",
    pc: "multisettingpcsample",
  });
});

test("buildCaseExecutionGroups normalizes fold devices and groups by HAP module", () => {
  const groups = buildCaseExecutionGroups(
    {
      caseId: "case",
      caseDir: "/tmp/case",
      baseProject: "/tmp/base",
      testPatch: "/tmp/case/test_patch.patch",
      goldenPatch: "/tmp/case/golden_patch.patch",
      testCaseTimeoutMs: AA_TEST_CASE_TIMEOUT_MS,
      failToPass: [],
      passToPass: [],
      deviceHapModules: {
        phone: "multisettingdefaultsample",
        tablet: "multisettingdefaultsample",
        pc: "multisettingpcsample",
      },
    },
    {
      devices: ["phone", "wide_fold", "foldable", "tablet", "pc"],
      deviceSuiteOverrides: {
        phone: ["PhoneSuite"],
        wide_fold: ["WideFoldSuite"],
        foldable: ["FoldableSuite"],
        tablet: ["TabletSuite"],
        pc: ["PcSuite"],
      },
      runAllTests: false,
    },
  );

  assert.deepEqual(groups, [
    {
      module: "multisettingdefaultsample",
      selection: {
        devices: ["phone", "wide_fold", "foldable", "tablet"],
        deviceSuiteOverrides: {
          phone: ["PhoneSuite"],
          wide_fold: ["WideFoldSuite"],
          foldable: ["FoldableSuite"],
          tablet: ["TabletSuite"],
        },
        runAllTests: false,
      },
    },
    {
      module: "multisettingpcsample",
      selection: {
        devices: ["pc"],
        deviceSuiteOverrides: { pc: ["PcSuite"] },
        runAllTests: false,
      },
    },
  ]);
});

test("loadCaseMetadata rejects unsupported device HAP mapping keys", async (t) => {
  const caseDir = await makeTempCase(t);
  await fs.mkdir(path.join(caseDir, "..", "base"), { recursive: true });
  await fs.writeFile(path.join(caseDir, "test_patch.patch"), "", "utf-8");
  await fs.writeFile(path.join(caseDir, "golden_patch.patch"), "", "utf-8");
  await fs.writeFile(
    path.join(caseDir, "metadata.json"),
    JSON.stringify({
      case_id: "case",
      base_project: "base",
      test_patch: "test_patch.patch",
      golden_patch: "golden_patch.patch",
      device_hap_modules: {
        phone: "entry",
        foldable: "entry",
      },
    }),
    "utf-8",
  );

  await assert.rejects(
    loadCaseMetadata(caseDir),
    /metadata\.device_hap_modules supports only phone, tablet, and pc/,
  );
});

test("buildCaseExecutionGroups requires a normalized deployment mapping", () => {
  assert.throws(
    () =>
      buildCaseExecutionGroups(
        {
          caseId: "case",
          caseDir: "/tmp/case",
          baseProject: "/tmp/base",
          testPatch: "/tmp/case/test_patch.patch",
          goldenPatch: "/tmp/case/golden_patch.patch",
          testCaseTimeoutMs: AA_TEST_CASE_TIMEOUT_MS,
          failToPass: [],
          passToPass: [],
          deviceHapModules: { tablet: "entry" },
        },
        { devices: ["foldable"], runAllTests: true },
      ),
    /metadata\.device_hap_modules\.phone is required for device foldable/,
  );
});

test("buildCaseDeviceSelection uses metadata device suites when present", () => {
  const matrixConfig = {
    devices: [
      { id: "phone", target: "127.0.0.1:15001", startEmulator: false },
      { id: "tablet", target: "127.0.0.1:15003", startEmulator: false },
    ],
  } as MatrixConfig;

  const selection = buildCaseDeviceSelection(
    {
      caseId: "case",
      caseDir: "/tmp/case",
      baseProject: "/tmp/base",
      testPatch: "/tmp/case/test_patch.patch",
      goldenPatch: "/tmp/case/golden_patch.patch",
      testCaseTimeoutMs: AA_TEST_CASE_TIMEOUT_MS,
      failToPass: [],
      passToPass: [],
      deviceTestSuites: {
        phone: [
          { suite: "CommonPassToPassTest" },
          { suite: "CommonPassToPassTest" },
        ],
      },
    },
    matrixConfig,
  );

  assert.deepEqual(selection, {
    devices: ["phone"],
    deviceSuiteOverrides: { phone: ["CommonPassToPassTest"] },
    runAllTests: false,
  });
  assert.throws(
    () =>
      buildCaseDeviceSelection(
        {
          caseId: "case",
          caseDir: "/tmp/case",
          baseProject: "/tmp/base",
          testPatch: "/tmp/case/test_patch.patch",
          goldenPatch: "/tmp/case/golden_patch.patch",
          testCaseTimeoutMs: AA_TEST_CASE_TIMEOUT_MS,
          failToPass: [],
          passToPass: [],
          deviceTestSuites: { foldable: [{ suite: "MdFailToPassTest" }] },
        },
        matrixConfig,
      ),
    /metadata device foldable is missing in machine config/,
  );
});

test("loadCaseMetadata accepts enabled devices without device test suites", async (t) => {
  const caseDir = await makeTempCase(t);
  await fs.mkdir(path.join(caseDir, "..", "base"), { recursive: true });
  await fs.writeFile(path.join(caseDir, "test_patch.patch"), "", "utf-8");
  await fs.writeFile(path.join(caseDir, "golden_patch.patch"), "", "utf-8");
  await fs.writeFile(
    path.join(caseDir, "metadata.json"),
    JSON.stringify({
      case_id: "responsive-repeat-layout",
      base_project: "base",
      test_patch: "test_patch.patch",
      golden_patch: "golden_patch.patch",
      enabled_devices: ["phone", "foldable", "phone"],
    }),
    "utf-8",
  );

  const metadata = await loadCaseMetadata(caseDir);

  assert.equal(metadata.deviceTestSuites, undefined);
  assert.deepEqual(metadata.enabledDevices, ["phone", "foldable"]);
  assert.equal(metadata.testCaseTimeoutMs, AA_TEST_CASE_TIMEOUT_MS);
});

test("loadCaseMetadata rejects invalid test case timeouts", async (t) => {
  const caseDir = await makeTempCase(t);
  await fs.mkdir(path.join(caseDir, "..", "base"), { recursive: true });
  await fs.writeFile(path.join(caseDir, "test_patch.patch"), "", "utf-8");
  await fs.writeFile(path.join(caseDir, "golden_patch.patch"), "", "utf-8");

  for (const value of [0, -1, 1.5, "30000"]) {
    await fs.writeFile(
      path.join(caseDir, "metadata.json"),
      JSON.stringify({
        case_id: "responsive-repeat-layout",
        base_project: "base",
        test_patch: "test_patch.patch",
        golden_patch: "golden_patch.patch",
        test_case_timeout_ms: value,
      }),
      "utf-8",
    );

    await assert.rejects(
      loadCaseMetadata(caseDir),
      /metadata\.test_case_timeout_ms must be a positive integer/,
    );
  }
});

test("loadCaseMetadata identifies an invalid metadata.json file", async (t) => {
  const caseDir = await makeTempCase(t);
  const metadataPath = path.join(caseDir, "metadata.json");
  await fs.writeFile(metadataPath, "{ invalid", "utf-8");

  await assert.rejects(loadCaseMetadata(caseDir), (error: Error) => {
    assert.match(error.message, /config_file_parse_failed/);
    assert.ok(error.message.includes(metadataPath));
    return true;
  });
});

test("buildCaseDeviceSelection falls back to enabled devices or machine devices for full test runs", () => {
  const matrixConfig = {
    devices: [
      { id: "phone", target: "127.0.0.1:15001", startEmulator: false },
      { id: "foldable", target: "127.0.0.1:15002", startEmulator: false },
      { id: "tablet", target: "127.0.0.1:15003", startEmulator: false },
    ],
  } as MatrixConfig;
  const baseMetadata = {
    caseId: "case",
    caseDir: "/tmp/case",
    baseProject: "/tmp/base",
    testPatch: "/tmp/case/test_patch.patch",
    goldenPatch: "/tmp/case/golden_patch.patch",
    testCaseTimeoutMs: AA_TEST_CASE_TIMEOUT_MS,
    failToPass: [],
    passToPass: [],
  };

  assert.deepEqual(
    buildCaseDeviceSelection(
      { ...baseMetadata, enabledDevices: ["phone", "foldable"] },
      matrixConfig,
    ),
    {
      devices: ["phone", "foldable"],
      runAllTests: true,
    },
  );
  assert.deepEqual(buildCaseDeviceSelection(baseMetadata, matrixConfig), {
    devices: ["phone", "foldable", "tablet"],
    runAllTests: true,
  });
  assert.throws(
    () =>
      buildCaseDeviceSelection(
        { ...baseMetadata, enabledDevices: ["watch"] },
        matrixConfig,
      ),
    /metadata device watch is missing in machine config/,
  );
});

test("buildCaseDeviceSelection filters metadata suites in requested device order", () => {
  const matrixConfig = {
    devices: [
      { id: "phone", target: "127.0.0.1:15001", startEmulator: false },
      { id: "tablet", target: "127.0.0.1:15003", startEmulator: false },
    ],
  } as MatrixConfig;

  const selection = buildCaseDeviceSelection(
    {
      caseId: "case",
      caseDir: "/tmp/case",
      baseProject: "/tmp/base",
      testPatch: "/tmp/case/test_patch.patch",
      goldenPatch: "/tmp/case/golden_patch.patch",
      testCaseTimeoutMs: AA_TEST_CASE_TIMEOUT_MS,
      failToPass: [],
      passToPass: [],
      deviceTestSuites: {
        phone: [{ suite: "PhoneSuite" }],
        tablet: [{ suite: "TabletSuite" }],
      },
    },
    matrixConfig,
    ["tablet", "phone", "tablet"],
  );

  assert.deepEqual(selection, {
    devices: ["tablet", "phone"],
    deviceSuiteOverrides: {
      tablet: ["TabletSuite"],
      phone: ["PhoneSuite"],
    },
    runAllTests: false,
  });
});

test("buildCaseDeviceSelection filters full test device selections", () => {
  const matrixConfig = {
    devices: [
      { id: "phone", target: "127.0.0.1:15001", startEmulator: false },
      { id: "tablet", target: "127.0.0.1:15003", startEmulator: false },
    ],
  } as MatrixConfig;
  const metadata = {
    caseId: "case",
    caseDir: "/tmp/case",
    baseProject: "/tmp/base",
    testPatch: "/tmp/case/test_patch.patch",
    goldenPatch: "/tmp/case/golden_patch.patch",
    testCaseTimeoutMs: AA_TEST_CASE_TIMEOUT_MS,
    failToPass: [],
    passToPass: [],
  };

  assert.deepEqual(
    buildCaseDeviceSelection(
      { ...metadata, enabledDevices: ["phone", "tablet"] },
      matrixConfig,
      ["tablet"],
    ),
    { devices: ["tablet"], runAllTests: true },
  );
  assert.deepEqual(
    buildCaseDeviceSelection(metadata, matrixConfig, ["phone"]),
    { devices: ["phone"], runAllTests: true },
  );
});

test("buildCaseDeviceSelection rejects devices outside the case selection", () => {
  const matrixConfig = {
    devices: [
      { id: "phone", target: "127.0.0.1:15001", startEmulator: false },
      { id: "tablet", target: "127.0.0.1:15003", startEmulator: false },
    ],
  } as MatrixConfig;

  assert.throws(
    () =>
      buildCaseDeviceSelection(
        {
          caseId: "case",
          caseDir: "/tmp/case",
          baseProject: "/tmp/base",
          testPatch: "/tmp/case/test_patch.patch",
          goldenPatch: "/tmp/case/golden_patch.patch",
          testCaseTimeoutMs: AA_TEST_CASE_TIMEOUT_MS,
          failToPass: [],
          passToPass: [],
          enabledDevices: ["phone"],
        },
        matrixConfig,
        ["tablet"],
      ),
    /case device tablet is not enabled by metadata or machine config/,
  );
});

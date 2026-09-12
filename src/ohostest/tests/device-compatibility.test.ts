import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyAnswerDeviceTypeChecks,
  harmonyDeviceTypeFor,
  withCaseDeviceTypeCompatibility,
} from "../src/case/deviceCompatibility.js";
import type { ExecutionResult } from "../src/execution/types/index.js";
import { parseJson5ish } from "../src/execution/project/json5ish.js";

async function makeTempProject(
  t: test.TestContext,
  deviceTypes: unknown = ["phone"],
): Promise<{ project: string; modulePath: string; original: string }> {
  const project = await fs.mkdtemp(
    path.join(os.tmpdir(), "ohostest-swe-tablet-"),
  );
  t.after(async () => {
    await fs.rm(project, { recursive: true, force: true });
  });
  await fs.writeFile(
    path.join(project, "build-profile.json5"),
    JSON.stringify({
      app: { products: [{ name: "default" }] },
      modules: [
        { name: "library", srcPath: "./commons/library" },
        { name: "entry", srcPath: "./products/entry" },
      ],
    }),
    "utf-8",
  );
  await fs.mkdir(path.join(project, "commons", "library"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(project, "commons", "library", "hvigorfile.ts"),
    "import { harTasks } from '@ohos/hvigor-ohos-plugin';\nexport default { system: harTasks, plugins: [] };\n",
    "utf-8",
  );
  await fs.mkdir(path.join(project, "products", "entry"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(project, "products", "entry", "hvigorfile.ts"),
    "import { hapTasks } from '@ohos/hvigor-ohos-plugin';\nexport default { system: hapTasks, plugins: [] };\n",
    "utf-8",
  );
  const modulePath = path.join(
    project,
    "products",
    "entry",
    "src",
    "main",
    "module.json5",
  );
  await fs.mkdir(path.dirname(modulePath), { recursive: true });
  const original = `{
    // Preserve this comment after the temporary compatibility adjustment.
    "module": {
      "name": "entry",
      "deviceTypes": ${JSON.stringify(deviceTypes)}
    }
  }\n`;
  await fs.writeFile(modulePath, original, "utf-8");
  return { project, modulePath, original };
}

async function addHspModule(
  project: string,
  options: { deviceTypes?: string[]; applyToProducts?: string[] } = {},
): Promise<{ modulePath: string; original: string }> {
  const buildProfilePath = path.join(project, "build-profile.json5");
  const buildProfile = parseJson5ish(
    await fs.readFile(buildProfilePath, "utf-8"),
  ) as { app: object; modules: object[] };
  buildProfile.modules.push({
    name: "common",
    srcPath: "./commons/common",
    ...(options.applyToProducts
      ? {
          targets: [
            { name: "default", applyToProducts: options.applyToProducts },
          ],
        }
      : {}),
  });
  await fs.writeFile(
    buildProfilePath,
    `${JSON.stringify(buildProfile, null, 2)}\n`,
    "utf-8",
  );
  const moduleRoot = path.join(project, "commons", "common");
  await fs.mkdir(moduleRoot, { recursive: true });
  await fs.writeFile(
    path.join(moduleRoot, "hvigorfile.ts"),
    "import { hspTasks } from '@ohos/hvigor-ohos-plugin';\nexport default { system: hspTasks, plugins: [] };\n",
    "utf-8",
  );
  const modulePath = path.join(moduleRoot, "src", "main", "module.json5");
  await fs.mkdir(path.dirname(modulePath), { recursive: true });
  const original = `{
    // Preserve the HSP config too.
    "module": {
      "name": "common",
      "type": "shared",
      "deviceTypes": ${JSON.stringify(options.deviceTypes ?? ["phone"])}
    }
  }\n`;
  await fs.writeFile(modulePath, original, "utf-8");
  return { modulePath, original };
}

test("harmonyDeviceTypeFor maps canonical runner device IDs", () => {
  assert.deepEqual(
    [
      "phone",
      "wide_fold",
      "foldable",
      "tablet",
      "pc",
      "2in1",
      "tv",
      "wearable",
      "car",
    ].map((deviceId) => harmonyDeviceTypeFor(deviceId)),
    [
      "phone",
      "phone",
      "phone",
      "tablet",
      "2in1",
      "2in1",
      "tv",
      "wearable",
      "car",
    ],
  );
  assert.throws(
    () => harmonyDeviceTypeFor("custom-tablet"),
    /case_device_type_unmapped: custom-tablet/,
  );
});

test("withCaseDeviceTypeCompatibility adds required types and returns the original HAP declaration", async (t) => {
  const { project, modulePath, original } = await makeTempProject(t);
  const hsp = await addHspModule(project);

  const result = await withCaseDeviceTypeCompatibility({
    project,
    deviceIds: ["phone", "tablet", "tablet"],
    run: async () => {
      const config = parseJson5ish(await fs.readFile(modulePath, "utf-8")) as {
        module: { deviceTypes: string[] };
      };
      assert.deepEqual(config.module.deviceTypes, ["phone", "tablet"]);
      const hspConfig = parseJson5ish(
        await fs.readFile(hsp.modulePath, "utf-8"),
      ) as { module: { deviceTypes: string[] } };
      assert.deepEqual(hspConfig.module.deviceTypes, ["phone", "tablet"]);
      return "completed";
    },
  });

  assert.equal(result.value, "completed");
  assert.deepEqual(result.assessment, {
    modulePath,
    declaredDeviceTypes: ["phone"],
    requiredByDevice: [
      { deviceId: "phone", deviceType: "phone" },
      { deviceId: "tablet", deviceType: "tablet" },
    ],
    injectedDeviceTypes: ["tablet"],
  });
  assert.equal(await fs.readFile(modulePath, "utf-8"), original);
  assert.equal(await fs.readFile(hsp.modulePath, "utf-8"), hsp.original);
});

test("withCaseDeviceTypeCompatibility appends multiple missing types in device order", async (t) => {
  const { project, modulePath } = await makeTempProject(t);

  const result = await withCaseDeviceTypeCompatibility({
    project,
    deviceIds: ["tablet", "pc", "tv", "wearable", "car"],
    run: async () => {
      const config = parseJson5ish(
        await fs.readFile(modulePath, "utf-8"),
      ) as { module: { deviceTypes: string[] } };
      assert.deepEqual(config.module.deviceTypes, [
        "phone",
        "tablet",
        "2in1",
        "tv",
        "wearable",
        "car",
      ]);
    },
  });

  assert.deepEqual(result.assessment.injectedDeviceTypes, [
    "tablet",
    "2in1",
    "tv",
    "wearable",
    "car",
  ]);
});

test("withCaseDeviceTypeCompatibility restores the original file and rethrows callback errors", async (t) => {
  const { project, modulePath, original } = await makeTempProject(t);
  const hsp = await addHspModule(project);
  const expectedError = new Error("run failed");

  await assert.rejects(
    withCaseDeviceTypeCompatibility({
      project,
      deviceIds: ["tablet"],
      run: async () => {
        throw expectedError;
      },
    }),
    (error) => error === expectedError,
  );
  assert.equal(await fs.readFile(modulePath, "utf-8"), original);
  assert.equal(await fs.readFile(hsp.modulePath, "utf-8"), hsp.original);
});

test("withCaseDeviceTypeCompatibility ignores HSP modules outside the selected product", async (t) => {
  const { project } = await makeTempProject(t);
  const hsp = await addHspModule(project, { applyToProducts: ["tablet"] });

  await withCaseDeviceTypeCompatibility({
    project,
    deviceIds: ["tablet"],
    run: async () => {
      assert.equal(await fs.readFile(hsp.modulePath, "utf-8"), hsp.original);
    },
  });
});

test("withCaseDeviceTypeCompatibility rejects invalid deviceTypes with a stable error", async (t) => {
  const { project } = await makeTempProject(t, ["phone", 1]);

  await assert.rejects(
    withCaseDeviceTypeCompatibility({
      project,
      deviceIds: ["tablet"],
      run: async () => undefined,
    }),
    /case_device_type_compatibility_invalid_module/,
  );
});

test("withCaseDeviceTypeCompatibility selects the requested HAP in a multi-HAP project", async (t) => {
  const { project, modulePath, original } = await makeTempProject(t);
  const buildProfilePath = path.join(project, "build-profile.json5");
  const buildProfile = parseJson5ish(
    await fs.readFile(buildProfilePath, "utf-8"),
  ) as { app: object; modules: object[] };
  buildProfile.modules.push({ name: "pc", srcPath: "./products/pc" });
  await fs.writeFile(
    buildProfilePath,
    `${JSON.stringify(buildProfile, null, 2)}\n`,
    "utf-8",
  );
  await fs.mkdir(path.join(project, "products", "pc"), { recursive: true });
  await fs.writeFile(
    path.join(project, "products", "pc", "hvigorfile.ts"),
    "import { hapTasks } from '@ohos/hvigor-ohos-plugin';\nexport default { system: hapTasks, plugins: [] };\n",
    "utf-8",
  );

  await withCaseDeviceTypeCompatibility({
    project,
    module: "entry",
    deviceIds: ["tablet"],
    run: async () => {
      const config = parseJson5ish(await fs.readFile(modulePath, "utf-8")) as {
        module: { deviceTypes: string[] };
      };
      assert.deepEqual(config.module.deviceTypes, ["phone", "tablet"]);
    },
  });

  assert.equal(await fs.readFile(modulePath, "utf-8"), original);
});

test("applyAnswerDeviceTypeChecks scores the original declaration without blocking executed tests", () => {
  const execution = executionResult(["phone", "tablet"]);
  const checked = applyAnswerDeviceTypeChecks(execution, {
    modulePath: "/project/entry/src/main/module.json5",
    declaredDeviceTypes: ["phone"],
    requiredByDevice: [
      { deviceId: "phone", deviceType: "phone" },
      { deviceId: "tablet", deviceType: "tablet" },
    ],
    injectedDeviceTypes: ["tablet"],
  });

  assert.equal(checked.status, "completed");
  const phone = checked.devices[0]!;
  const tablet = checked.devices[1]!;
  assert.equal(phone.status, "passed");
  assert.equal(phone.testsRun, 2);
  assert.equal(phone.passes, 2);
  assert.equal(phone.suiteResults.at(-1)?.testCases[0]?.status, "passed");
  assert.equal(tablet.status, "failed");
  assert.equal(tablet.testsRun, 2);
  assert.equal(tablet.failures, 1);
  assert.equal(tablet.passes, 1);
  assert.deepEqual(tablet.suiteResults.at(-1), {
    suiteClass: "ModuleDeviceTypeCompatibility",
    status: "failed",
    testsRun: 1,
    failures: 1,
    errors: 0,
    passes: 0,
    ignored: 0,
    reportCode: -1,
    ok: false,
    testCases: [
      {
        name: "should_declare_tablet_device_type",
        status: "failed",
        statusCode: -2,
        message:
          '/project/entry/src/main/module.json5 module.deviceTypes does not include "tablet"; the runner temporarily injected it for test execution.',
      },
    ],
  });
});

function executionResult(deviceIds: string[]): ExecutionResult {
  return {
    project: "/project",
    status: "completed",
    startedAt: "2026-08-24T00:00:00.000Z",
    finishedAt: "2026-08-24T00:00:01.000Z",
    durationMs: 1000,
    build: {
      status: "passed",
      appHap: "/project/app.hap",
      testHap: "/project/test.hap",
    },
    devices: deviceIds.map((id) => ({
      id,
      target: `127.0.0.1:${id}`,
      status: "passed",
      testsRun: 1,
      failures: 0,
      errors: 0,
      passes: 1,
      ignored: 0,
      suiteResults: [
        {
          suiteClass: `${id}Suite`,
          status: "passed",
          testsRun: 1,
          failures: 0,
          errors: 0,
          passes: 1,
          ignored: 0,
          reportCode: 0,
          ok: true,
          testCases: [],
        },
      ],
      durationMs: 1,
      log: "commands.jsonl",
    })),
    diagnostics: [],
  };
}

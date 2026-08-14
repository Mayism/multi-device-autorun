import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withSweTabletCompatibility } from "../src/case/deviceCompatibility.js";
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

test("withSweTabletCompatibility temporarily adds tablet and restores the original file", async (t) => {
  const { project, modulePath, original } = await makeTempProject(t);
  const hsp = await addHspModule(project);

  const result = await withSweTabletCompatibility({
    project,
    enabled: true,
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

  assert.equal(result, "completed");
  assert.equal(await fs.readFile(modulePath, "utf-8"), original);
  assert.equal(await fs.readFile(hsp.modulePath, "utf-8"), hsp.original);
});

test("withSweTabletCompatibility restores the original file and rethrows callback errors", async (t) => {
  const { project, modulePath, original } = await makeTempProject(t);
  const hsp = await addHspModule(project);
  const expectedError = new Error("run failed");

  await assert.rejects(
    withSweTabletCompatibility({
      project,
      enabled: true,
      run: async () => {
        throw expectedError;
      },
    }),
    (error) => error === expectedError,
  );
  assert.equal(await fs.readFile(modulePath, "utf-8"), original);
  assert.equal(await fs.readFile(hsp.modulePath, "utf-8"), hsp.original);
});

test("withSweTabletCompatibility ignores HSP modules outside the selected product", async (t) => {
  const { project } = await makeTempProject(t);
  const hsp = await addHspModule(project, { applyToProducts: ["tablet"] });

  await withSweTabletCompatibility({
    project,
    enabled: true,
    run: async () => {
      assert.equal(await fs.readFile(hsp.modulePath, "utf-8"), hsp.original);
    },
  });
});

test("withSweTabletCompatibility rejects invalid deviceTypes with a stable error", async (t) => {
  const { project } = await makeTempProject(t, ["phone", 1]);

  await assert.rejects(
    withSweTabletCompatibility({
      project,
      enabled: true,
      run: async () => undefined,
    }),
    /swe_tablet_compatibility_invalid_module/,
  );
});

test("withSweTabletCompatibility selects the requested HAP in a multi-HAP project", async (t) => {
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

  await withSweTabletCompatibility({
    project,
    module: "entry",
    enabled: true,
    run: async () => {
      const config = parseJson5ish(await fs.readFile(modulePath, "utf-8")) as {
        module: { deviceTypes: string[] };
      };
      assert.deepEqual(config.module.deviceTypes, ["phone", "tablet"]);
    },
  });

  assert.equal(await fs.readFile(modulePath, "utf-8"), original);
});

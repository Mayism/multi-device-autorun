import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverProjectInfo } from "../src/execution/project/discovery.js";

interface ModuleFixture {
  name: string;
  srcPath: string;
  type: string;
  packageType: "hap" | "har" | "hsp";
  applyToProducts?: string[];
  packageName?: string;
  dependencies?: Record<string, string>;
}

async function makeProject(
  t: test.TestContext,
  modules: ModuleFixture[],
): Promise<string> {
  const project = await fs.mkdtemp(
    path.join(os.tmpdir(), "ohostest-project-discovery-"),
  );
  t.after(async () => {
    await fs.rm(project, { recursive: true, force: true });
  });

  await fs.mkdir(path.join(project, "AppScope"), { recursive: true });
  await fs.writeFile(
    path.join(project, "AppScope", "app.json5"),
    JSON.stringify({ app: { bundleName: "example.bundle" } }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(project, "build-profile.json5"),
    JSON.stringify({
      app: { products: [{ name: "default" }] },
      modules: modules.map((module) => ({
        name: module.name,
        srcPath: `./${module.srcPath}`,
        ...(module.applyToProducts
          ? {
              targets: [
                {
                  name: "default",
                  applyToProducts: module.applyToProducts,
                },
              ],
            }
          : {}),
      })),
    }),
    "utf-8",
  );

  for (const module of modules) {
    await fs.mkdir(path.join(project, module.srcPath, "src", "main"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(project, module.srcPath, "src", "main", "module.json5"),
      JSON.stringify({
        module: { name: module.name, type: module.type },
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(project, module.srcPath, "oh-package.json5"),
      JSON.stringify({
        name: module.packageName ?? module.name,
        dependencies: module.dependencies ?? {},
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(project, module.srcPath, "hvigorfile.ts"),
      [
        `import { ${module.packageType}Tasks } from '@ohos/hvigor-ohos-plugin';`,
        `export default { system: ${module.packageType}Tasks, plugins: [] };`,
        "",
      ].join("\n"),
      "utf-8",
    );
  }

  for (const hap of modules.filter((module) => module.packageType === "hap")) {
    await fs.mkdir(path.join(project, hap.srcPath, "src", "ohosTest"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(project, hap.srcPath, "src", "ohosTest", "module.json5"),
      JSON.stringify({ module: { name: `${hap.name}_test` } }),
      "utf-8",
    );
  }
  return project;
}

test("discoverProjectInfo finds shared modules in build-profile order", async (t) => {
  const project = await makeProject(t, [
    {
      name: "entry",
      srcPath: "products/entry",
      type: "entry",
      packageType: "hap",
    },
    {
      name: "common",
      srcPath: "commons/common",
      type: "shared",
      packageType: "hsp",
    },
    {
      name: "styles",
      srcPath: "commons/styles",
      type: "shared",
      packageType: "hsp",
    },
  ]);

  const info = await discoverProjectInfo(project);

  assert.deepEqual(info.sharedModules, [
    {
      name: "common",
      srcPath: "commons/common",
      packageName: "common",
      dependencies: [],
      outputDir: path.join(
        project,
        "commons/common/build/default/outputs/default",
      ),
    },
    {
      name: "styles",
      srcPath: "commons/styles",
      packageName: "styles",
      dependencies: [],
      outputDir: path.join(
        project,
        "commons/styles/build/default/outputs/default",
      ),
    },
  ]);
});

test("discoverProjectInfo excludes non-shared and other-product modules", async (t) => {
  const project = await makeProject(t, [
    {
      name: "entry",
      srcPath: "products/entry",
      type: "entry",
      packageType: "hap",
    },
    {
      name: "feature",
      srcPath: "features/feature",
      type: "feature",
      packageType: "har",
    },
    {
      name: "tablet_common",
      srcPath: "commons/tablet_common",
      type: "shared",
      packageType: "hsp",
      applyToProducts: ["tablet"],
    },
  ]);

  const info = await discoverProjectInfo(project);

  assert.deepEqual(info.sharedModules, []);
});

test("discoverProjectInfo reports the module when module.json5 is missing", async (t) => {
  const project = await makeProject(t, [
    {
      name: "entry",
      srcPath: "products/entry",
      type: "entry",
      packageType: "hap",
    },
    {
      name: "common",
      srcPath: "commons/common",
      type: "shared",
      packageType: "hsp",
    },
  ]);
  await fs.rm(path.join(project, "commons/common/src/main/module.json5"));

  await assert.rejects(
    discoverProjectInfo(project),
    /module common.*module\.json5/i,
  );
});

test("discoverProjectInfo orders shared modules after their shared dependencies", async (t) => {
  const project = await makeProject(t, [
    {
      name: "entry",
      srcPath: "products/entry",
      type: "entry",
      packageType: "hap",
    },
    {
      name: "common",
      srcPath: "commons/common",
      type: "shared",
      packageType: "hsp",
      packageName: "@example/common",
      dependencies: { "@example/utils": "1.0.0" },
    },
    {
      name: "utils",
      srcPath: "commons/utils",
      type: "shared",
      packageType: "hsp",
      packageName: "@example/utils",
    },
  ]);

  const info = await discoverProjectInfo(project);

  assert.deepEqual(
    info.sharedModules.map((moduleInfo) => moduleInfo.name),
    ["utils", "common"],
  );
});

test("discoverProjectInfo selects a renamed HAP module instead of the first module", async (t) => {
  const project = await makeProject(t, [
    {
      name: "library",
      srcPath: "commons/library",
      type: "har",
      packageType: "har",
    },
    {
      name: "phone",
      srcPath: "products/phone",
      type: "entry",
      packageType: "hap",
    },
  ]);

  const info = await discoverProjectInfo(project);

  assert.equal(info.moduleName, "phone");
  assert.equal(info.moduleSrcPath, "products/phone");
  assert.equal(info.testModuleName, "phone_test");
  assert.match(
    info.appHap,
    /products\/phone\/build\/default\/outputs\/default\/phone-default-unsigned\.hap$/,
  );
});

test("discoverProjectInfo rejects a project without a HAP module", async (t) => {
  const project = await makeProject(t, [
    {
      name: "library",
      srcPath: "commons/library",
      type: "har",
      packageType: "har",
    },
  ]);

  await assert.rejects(
    discoverProjectInfo(project),
    /project_hap_module_not_found/,
  );
});

test("discoverProjectInfo rejects multiple HAP modules", async (t) => {
  const project = await makeProject(t, [
    {
      name: "phone",
      srcPath: "products/phone",
      type: "entry",
      packageType: "hap",
    },
    {
      name: "tablet",
      srcPath: "products/tablet",
      type: "feature",
      packageType: "hap",
    },
  ]);

  await assert.rejects(
    discoverProjectInfo(project),
    /project_hap_module_ambiguous: phone, tablet/,
  );
});

test("discoverProjectInfo selects an explicitly requested HAP module", async (t) => {
  const project = await makeProject(t, [
    {
      name: "phone",
      srcPath: "products/phone",
      type: "entry",
      packageType: "hap",
    },
    {
      name: "pc",
      srcPath: "products/pc",
      type: "entry",
      packageType: "hap",
    },
  ]);

  const info = await discoverProjectInfo(project, "pc");

  assert.equal(info.moduleName, "pc");
  assert.equal(info.moduleSrcPath, "products/pc");
  assert.equal(info.testModuleName, "pc_test");
  assert.match(
    info.appHap,
    /products\/pc\/build\/default\/outputs\/default\/pc-default-unsigned\.hap$/,
  );
});

test("discoverProjectInfo rejects an explicit module that is not a HAP", async (t) => {
  const project = await makeProject(t, [
    {
      name: "phone",
      srcPath: "products/phone",
      type: "entry",
      packageType: "hap",
    },
    {
      name: "common",
      srcPath: "commons/common",
      type: "har",
      packageType: "har",
    },
  ]);

  await assert.rejects(
    discoverProjectInfo(project, "common"),
    /project_hap_module_invalid: common/,
  );
});

test("discoverProjectInfo identifies an invalid build-profile.json5 file", async (t) => {
  const project = await makeProject(t, [
    {
      name: "entry",
      srcPath: "products/entry",
      type: "entry",
      packageType: "hap",
    },
  ]);
  const buildProfilePath = path.join(project, "build-profile.json5");
  await fs.writeFile(buildProfilePath, "{ invalid", "utf-8");

  await assert.rejects(discoverProjectInfo(project), (error: Error) => {
    assert.match(error.message, /config_file_parse_failed/);
    assert.ok(error.message.includes(buildProfilePath));
    return true;
  });
});

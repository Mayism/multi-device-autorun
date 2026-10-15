import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  filterGeneratedArtifactPatch,
  isGeneratedArtifactExcluded,
  pruneGeneratedArtifacts,
  restoreGeneratedBuildMode,
} from "./generated-artifact-filter.mjs";

test("patch excludes build outputs and UI dumps while retaining source and ordinary JSON", () => {
  const paths = [
    ".hvigor/cache.bin", "module/build/output.hap", "module/oh_modules/lib/index.js",
    "local.properties", "layout_101436792.json", "screenshots/device-verify/wms.txt",
    "entry/src/main/ets/pages/Index.ets", "layout.json", "web/src/layout.json",
  ];
  const patch = paths.map((name) => `diff --git a/${name} b/${name}\n+code\n`).join("");
  const filtered = filterGeneratedArtifactPatch(patch);
  assert.equal(filtered, paths.slice(-3).map((name) => `diff --git a/${name} b/${name}\n+code\n`).join(""));
  const emptyLayout = "diff --git a/layout.json b/layout.json\nnew file mode 100644\nindex 0000000..e69de29\n";
  assert.equal(filterGeneratedArtifactPatch(emptyLayout + patch), filtered);
});

test("only DevEco's known BuildProfile mode rewrite is restored", () => {
  const baseline = "export const BUILD_MODE_NAME = 'test';\nexport const TARGET_NAME = 'default';\n";
  const current = "export const BUILD_MODE_NAME = 'debug';\nexport const TARGET_NAME = 'agent-target';\n";
  assert.equal(
    restoreGeneratedBuildMode(baseline, current, "features/shopping/BuildProfile.ets"),
    "export const BUILD_MODE_NAME = 'test';\nexport const TARGET_NAME = 'agent-target';\n",
  );
  assert.equal(restoreGeneratedBuildMode(baseline, current, "src/Other.ets"), current);
  assert.equal(restoreGeneratedBuildMode(baseline.replace("'test'", "'release'"), current, "BuildProfile.ets"), current);
});

test("pruning retains .onemulti while keeping it excluded from deliverables", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-artifacts-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await fs.mkdir(path.join(root, ".onemulti"), { recursive: true });
  await fs.writeFile(path.join(root, ".onemulti", "state.json"), "{}\n");
  await fs.mkdir(path.join(root, "__pycache__"), { recursive: true });
  await fs.writeFile(path.join(root, "__pycache__", "cache.pyc"), "cache");
  await fs.mkdir(path.join(root, "evidence", "tmp"), { recursive: true });
  await fs.writeFile(path.join(root, "evidence", "tmp", "trace.txt"), "trace\n");

  const removed = await pruneGeneratedArtifacts(root);

  assert.equal(isGeneratedArtifactExcluded(".onemulti/state.json"), true);
  assert.equal(await fs.readFile(path.join(root, ".onemulti", "state.json"), "utf8"), "{}\n");
  assert.equal(removed.includes(".onemulti"), false);
  await assert.rejects(fs.access(path.join(root, "__pycache__")));
  await assert.rejects(fs.access(path.join(root, "evidence", "tmp")));
});

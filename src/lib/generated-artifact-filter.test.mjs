import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isGeneratedArtifactExcluded,
  pruneGeneratedArtifacts,
} from "./generated-artifact-filter.mjs";

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

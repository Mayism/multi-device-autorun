import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ScoreGraphState } from "../../workflow/graph/state.js";
import type { TaskUnderstandingDeps } from "../../workflow/nodes/taskUnderstanding/types.js";
import { ensureEffectivePatchPath } from "../../workflow/nodes/taskUnderstanding/tools.js";
import { collectEvidence } from "../../rules/evidence/collectEvidence.js";

async function makeProject(root: string, changedValue: string): Promise<void> {
  const sourceDir = path.join(root, "entry", "src", "main", "ets", "pages");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, "Changed.ets"), `${changedValue}\n`);
  await fs.writeFile(path.join(sourceDir, "Unchanged.ets"), "same\n");
}

test("empty patch is regenerated from explicit original and base paths, then scopes base evidence", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "whitebox-explicit-diff-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const originalDir = path.join(root, "source-before");
  const baseDir = path.join(root, "base");
  const emptyPatchPath = path.join(root, "diff", "changes.patch");
  const caseDir = path.join(root, "whitebox");
  await makeProject(originalDir, "old value");
  await makeProject(baseDir, "new value");
  await fs.mkdir(path.dirname(emptyPatchPath), { recursive: true });
  await fs.writeFile(emptyPatchPath, "");

  const state = {
    caseDir,
    caseInput: {
      caseId: "direct-base",
      promptText: "evaluate changed code",
      originalProjectPath: originalDir,
      generatedProjectPath: baseDir,
      originalProjectProvided: true,
      patchPath: emptyPatchPath,
    },
  } as ScoreGraphState;
  const deps = {
    artifactStore: { writeText: async () => undefined },
  } as unknown as TaskUnderstandingDeps;

  const effectivePatchPath = await ensureEffectivePatchPath(state, deps);
  assert.ok(effectivePatchPath);
  assert.match(await fs.readFile(effectivePatchPath, "utf8"), /new value/);
  await assert.rejects(fs.access(path.join(root, "workspace")));

  const evidence = await collectEvidence({
    ...state.caseInput,
    patchPath: effectivePatchPath,
  });
  assert.deepEqual(
    evidence.workspaceFiles.map((file) => file.relativePath),
    ["entry/src/main/ets/pages/Changed.ets"],
  );
  assert.equal(evidence.workspaceFiles[0]?.content, "new value\n");
  assert.equal(evidence.summary.hasPatch, true);
});

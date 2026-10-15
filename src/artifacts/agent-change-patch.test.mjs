import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateAgentChangePatch } from "./agent-change-patch.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("generated patch applies Agent edits without DevEco changes or tool artifacts", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-agent-patch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const replay = path.join(root, "replay");
  const patchPath = path.join(root, "changes.patch");
  await fs.mkdir(path.join(project, "entry", "src"), { recursive: true });
  git(project, "init");
  git(project, "config", "user.name", "test");
  git(project, "config", "user.email", "test@example.local");
  await fs.writeFile(path.join(project, "entry", "BuildProfile.ets"), "export const BUILD_MODE_NAME = 'test';\nexport const TARGET_NAME = 'default';\n");
  await fs.writeFile(path.join(project, "entry", "src", "Page.ets"), "old page\n");
  git(project, "add", "-A");
  git(project, "commit", "-m", "baseline");
  const baseline = git(project, "rev-parse", "HEAD");
  git(root, "clone", project, replay);

  await fs.writeFile(path.join(project, "entry", "BuildProfile.ets"), "export const BUILD_MODE_NAME = 'debug';\nexport const TARGET_NAME = 'agent-target';\n");
  await fs.writeFile(path.join(project, "entry", "src", "Page.ets"), "agent page\n");
  await fs.mkdir(path.join(project, "entry", "build"));
  await fs.writeFile(path.join(project, "entry", "build", "app.hap"), "compiled");
  await fs.mkdir(path.join(project, "entry", ".hvigor"));
  await fs.writeFile(path.join(project, "entry", ".hvigor", "cache"), "compiled");
  await fs.writeFile(path.join(project, "layout_101436792.json"), "{\"ui\":true}\n");
  await fs.writeFile(path.join(project, "entry", "src", "data.json"), "{\"agent\":true}\n");

  await generateAgentChangePatch(project, baseline, patchPath);
  const patch = await fs.readFile(patchPath, "utf8");
  assert.match(patch, /agent-target/);
  assert.match(patch, /agent page/);
  assert.match(patch, /data\.json/);
  assert.doesNotMatch(patch, /^[+-]export const BUILD_MODE_NAME/m);
  assert.doesNotMatch(patch, /app\.hap|layout_101436792|\.hvigor/);
  git(replay, "apply", "--check", patchPath);
  git(replay, "apply", patchPath);
  assert.equal(await fs.readFile(path.join(replay, "entry", "BuildProfile.ets"), "utf8"), "export const BUILD_MODE_NAME = 'test';\nexport const TARGET_NAME = 'agent-target';\n");

  await fs.writeFile(path.join(project, "entry", "BuildProfile.ets"), "export const BUILD_MODE_NAME = 'debug';\nexport const TARGET_NAME = 'default';\n");
  await fs.writeFile(path.join(project, "entry", "src", "Page.ets"), "old page\n");
  await fs.rm(path.join(project, "entry", "src", "data.json"));
  await generateAgentChangePatch(project, baseline, patchPath);
  assert.equal(await fs.readFile(patchPath, "utf8"), "");
});

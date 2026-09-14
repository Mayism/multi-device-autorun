import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  agentCaseLayout,
  materializeAgentCaseProjects,
  normalizeCasePlatform,
  prepareAgentCaseWorkspace,
} from "../runtime/agent-case-workspace.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-agent-case-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const caseRoot = path.join(root, "CaseWeb");
  const base = path.join(caseRoot, "base");
  const web = path.join(caseRoot, "web");
  await fs.mkdir(base, { recursive: true });
  await fs.mkdir(web, { recursive: true });
  await fs.writeFile(path.join(base, "app.txt"), "base\n");
  await fs.writeFile(path.join(web, "page.txt"), "web\n");
  await fs.writeFile(path.join(caseRoot, "golden_patch.patch"), "hidden\n");
  return { root, caseRoot, base, web, run: path.join(root, "run") };
}

test("case platform defaults to native and normalizes metadata values", () => {
  assert.equal(normalizeCasePlatform(undefined), "native");
  assert.equal(normalizeCasePlatform({ platform: " Web " }), "web");
});

test("native Agent workspace keeps the existing single-project layout", async (t) => {
  const f = await fixture(t);
  const caseInfo = {
    name: "CaseNative",
    platform: "native",
    projectName: "base",
    projectDir: f.base,
  };
  const layout = agentCaseLayout(caseInfo, f.run);
  await prepareAgentCaseWorkspace(caseInfo, layout);

  assert.equal(layout.projectDir, path.join(f.run, "base"));
  assert.equal(layout.buildProjectDir, layout.projectDir);
  assert.equal(await fs.readFile(path.join(layout.projectDir, "app.txt"), "utf8"), "base\n");
  await assert.rejects(fs.access(path.join(layout.projectDir, "web")));
});

test("web Agent workspace contains base and web while hiding evaluation files", async (t) => {
  const f = await fixture(t);
  const caseInfo = {
    name: "CaseWeb",
    platform: "web",
    projectName: "base",
    projectDir: f.base,
    webProjectDir: f.web,
  };
  const layout = agentCaseLayout(caseInfo, f.run);
  await prepareAgentCaseWorkspace(caseInfo, layout);

  assert.equal(layout.projectDir, path.join(f.run, "project"));
  assert.equal(layout.buildProjectDir, path.join(layout.projectDir, "base"));
  assert.equal(await fs.readFile(path.join(layout.projectDir, "base/app.txt"), "utf8"), "base\n");
  assert.equal(await fs.readFile(path.join(layout.projectDir, "web/page.txt"), "utf8"), "web\n");
  await assert.rejects(fs.access(path.join(layout.projectDir, "golden_patch.patch")));

  await fs.writeFile(path.join(layout.projectDir, "web/page.txt"), "adapted\n");
  await materializeAgentCaseProjects(caseInfo, layout, f.run);
  assert.equal(await fs.readFile(path.join(f.run, "base/app.txt"), "utf8"), "base\n");
  assert.equal(await fs.readFile(path.join(f.run, "web/page.txt"), "utf8"), "adapted\n");
});

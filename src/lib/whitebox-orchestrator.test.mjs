import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bindHarmonyBotWhiteboxRuntime,
  normalizeWhiteboxConfig,
  prepareWhiteboxInput,
} from "./whitebox-orchestrator.mjs";

test("whitebox runtime always binds to the HarmonyBot OpenCode source", () => {
  const normalized = normalizeWhiteboxConfig({ enabled: true }, "/output");
  const bound = bindHarmonyBotWhiteboxRuntime(normalized, [
    { id: "software-engineering", mode: "softwareEngineering", root: "/software" },
    { id: "harmonybot", mode: "harmonyBot", root: "/harmony" },
  ]);

  assert.deepEqual(bound.runtime, { source: "harmonyBot", root: "/harmony" });
});

test("whitebox runtime requires a HarmonyBot source when enabled", () => {
  const normalized = normalizeWhiteboxConfig({ enabled: true }, "/output");
  assert.throws(
    () => bindHarmonyBotWhiteboxRuntime(normalized, [
      { id: "software-engineering", mode: "softwareEngineering", root: "/software" },
    ]),
    /未配置 HarmonyBot 来源/,
  );
});

test("whitebox input keeps original and base while allowing the patch to be generated later", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-whitebox-input-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const caseRunDir = path.join(root, "case-run");
  const originalDir = path.join(caseRunDir, "original");
  const baseDir = path.join(caseRunDir, "base");
  const promptPath = path.join(root, "input.txt");
  await fs.mkdir(originalDir, { recursive: true });
  await fs.mkdir(baseDir, { recursive: true });
  await fs.writeFile(path.join(originalDir, "main.ets"), "const value = 'old';\n");
  await fs.writeFile(path.join(baseDir, "main.ets"), "const value = 'new';\n");
  await fs.writeFile(promptPath, "修改页面\n");

  const prepared = await prepareWhiteboxInput({
    batchId: "batch-1",
    caseInfo: { name: "CasePatchScope", promptPath },
    agentResult: {
      resultPath: path.join(caseRunDir, "result.json"),
      projectDir: baseDir,
    },
    execution: { additionalPrompt: "支持横竖屏" },
    config: { prompt: { includeAdditionalPrompt: true } },
  });

  const manifest = JSON.parse(await fs.readFile(prepared.inputPath, "utf8"));
  assert.equal(manifest.originalProjectPath, originalDir);
  assert.equal(manifest.generatedProjectPath, baseDir);
  assert.equal(Object.hasOwn(manifest, "patchPath"), false);
  assert.equal(Object.hasOwn(manifest.metadata, "patchSha256"), false);
});

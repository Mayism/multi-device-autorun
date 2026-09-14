import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bindHarmonyBotWhiteboxRuntime,
  normalizeWhiteboxConfig,
  prepareWhiteboxInput,
  resolveWhiteboxJudgeRuntime,
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

test("whitebox judge resolves its Provider, dynamic model and credential from HarmonyBot", async () => {
  const runtime = await resolveWhiteboxJudgeRuntime({
    client: {
      getProviders: async () => ({
        providers: [{
          id: "zhipuai-coding-plan",
          key: "test-runtime-key",
          options: { baseURL: "https://runtime.example.test" },
          models: { "glm-5.2": { id: "glm-5.2", name: "GLM 5.2" } },
        }],
      }),
    },
    serverConfig: {
      provider: {
        "zhipuai-coding-plan": {
          options: { baseURL: "https://configured.example.test" },
        },
      },
    },
    judge: { providerId: "zhipuai-coding-plan", modelId: "glm-5.2" },
    generationModel: { providerId: "other", modelId: "other-model" },
    directory: "/whitebox-workspace",
  });

  assert.equal(runtime.providerId, "zhipuai-coding-plan");
  assert.equal(runtime.modelId, "glm-5.2");
  assert.equal(runtime.providerConfig.options.apiKey, "test-runtime-key");
  assert.equal(runtime.providerConfig.options.baseURL, "https://configured.example.test");
  assert.deepEqual(Object.keys(runtime.providerConfig.models), ["glm-5.2"]);
});

test("whitebox judge remains compatible with a static HarmonyBot Provider", async () => {
  const runtime = await resolveWhiteboxJudgeRuntime({
    client: { getProviders: async () => { throw new Error("unsupported"); } },
    serverConfig: {
      provider: {
        deepseek: {
          options: { apiKey: "test-static-key" },
          models: { "deepseek-v4": { name: "DeepSeek V4" } },
        },
      },
    },
    judge: { providerId: "deepseek", modelId: "deepseek-v4" },
    directory: "/whitebox-workspace",
  });

  assert.equal(runtime.providerConfig.options.apiKey, "test-static-key");
  assert.deepEqual(Object.keys(runtime.providerConfig.models), ["deepseek-v4"]);
});

test("whitebox judge reports a missing model from its HarmonyBot runtime", async () => {
  await assert.rejects(
    resolveWhiteboxJudgeRuntime({
      client: {
        getProviders: async () => ({
          providers: [{ id: "zhipuai-coding-plan", models: { "glm-5.3": {} } }],
        }),
      },
      serverConfig: { provider: {} },
      judge: { providerId: "zhipuai-coding-plan", modelId: "glm-5.2" },
      directory: "/whitebox-workspace",
    }),
    /HarmonyBot Provider zhipuai-coding-plan 未配置白盒裁判模型: glm-5\.2/,
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

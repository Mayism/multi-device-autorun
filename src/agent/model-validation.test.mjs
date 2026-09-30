import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfiguredModel } from "./model-validation.mjs";

const runtimeClient = (providers) => ({
  getProviders: async () => ({ providers }),
});

test("configured model resolves from HarmonyBot dynamic provider catalog", async () => {
  const result = await resolveConfiguredModel({
    client: runtimeClient([
      { id: "zhipuai-coding-plan", models: { "glm-5.2": { id: "glm-5.2" } } },
    ]),
    config: {
      provider: {
        "zhipuai-coding-plan": { options: { baseURL: "https://example.test" } },
      },
    },
    providerId: "zhipuai-coding-plan",
    modelId: "glm-5.2",
    directory: "/workspace",
  });

  assert.deepEqual(result, {
    providerId: "zhipuai-coding-plan",
    modelId: "glm-5.2",
  });
});

test("configured model remains compatible with static Software Engineering config", async () => {
  const result = await resolveConfiguredModel({
    client: { getProviders: async () => { throw new Error("unsupported"); } },
    config: {
      provider: {
        deepseek: { models: { "deepseek-v4": {} } },
      },
    },
    providerId: "deepseek",
    modelId: "deepseek-v4",
    directory: "/workspace",
  });

  assert.deepEqual(result, { providerId: "deepseek", modelId: "deepseek-v4" });
});

test("configured model still rejects a missing dynamic model", async () => {
  await assert.rejects(
    resolveConfiguredModel({
      client: runtimeClient([
        { id: "zhipuai-coding-plan", models: { "glm-5.3": {} } },
      ]),
      config: { provider: { "zhipuai-coding-plan": { models: {} } } },
      providerId: "zhipuai-coding-plan",
      modelId: "glm-5.2",
      directory: "/workspace",
    }),
    /未配置模型: glm-5\.2（可用模型: glm-5\.3）/,
  );
});

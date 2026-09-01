import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { normalizeAgentTargets, normalizeGenerationModel } from "./agent-targets.mjs";

test("legacy opencodeSource becomes one serial target", () => {
  const result = normalizeAgentTargets(
    { mode: "harmonyBot", root: "../extensions", agent: "harmonyos-multi-device" },
    { baseDir: "/tmp/config" },
  );
  assert.equal(result.multiple, false);
  assert.equal(result.legacy, true);
  assert.deepEqual(result.targets[0], {
    id: "harmonyBot",
    label: "harmonyBot",
    mode: "harmonyBot",
    root: path.resolve("/tmp/config", "../extensions"),
    agent: "harmonyos-multi-device",
  });
});

test("harmonyBot target requires its own agent", () => {
  assert.throws(
    () => normalizeAgentTargets({ mode: "harmonyBot", root: "/hb" }),
    /未配置 agent/,
  );
});

test("multi target config preserves order and forces built-in software agent", () => {
  const result = normalizeAgentTargets({
    targets: [
      { id: "harmonybot", mode: "harmonyBot", root: "/hb", agent: "harmonyos-multi-device" },
      { id: "software-engineering", mode: "softwareEngineering", root: "/se", agent: "ignored" },
    ],
  });
  assert.equal(result.multiple, true);
  assert.deepEqual(result.targets.map((item) => [item.id, item.agent]), [
    ["harmonybot", "harmonyos-multi-device"],
    ["software-engineering", "build"],
  ]);
});

test("multi target config requires explicit unique ids", () => {
  assert.throws(() => normalizeAgentTargets({ targets: [
    { mode: "harmonyBot", root: "/hb", agent: "a" },
    { id: "se", mode: "softwareEngineering", root: "/se" },
  ] }), /显式设置唯一 id/);
  assert.throws(() => normalizeAgentTargets({ targets: [
    { id: "same", mode: "harmonyBot", root: "/hb", agent: "a" },
    { id: "same", mode: "softwareEngineering", root: "/se" },
  ] }), /id 重复/);
});

test("multi target model requires an exact provider", () => {
  assert.throws(() => normalizeGenerationModel({ model: "glm-5.2" }, { requireProvider: true }), /execution.providerId/);
  assert.deepEqual(
    normalizeGenerationModel({ providerId: "zhipuai-coding-plan", model: "glm-5.2" }, { requireProvider: true }),
    { providerId: "zhipuai-coding-plan", modelId: "glm-5.2" },
  );
});

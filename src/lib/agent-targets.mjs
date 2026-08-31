import path from "node:path";

const SOURCE_MODES = new Set(["harmonyBot", "softwareEngineering"]);

function text(value) {
  return String(value ?? "").trim();
}

function targetId(value, fallback) {
  const id = text(value || fallback);
  if (!id || id.length > 120 || !/^[0-9A-Za-z._-]+$/.test(id)) {
    throw new Error(`Agent 目标 id 只能包含字母、数字、点、下划线和连字符: ${id || "<empty>"}`);
  }
  return id;
}

function normalizeSource(source, { baseDir, defaultAgent, index, multiple }) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`server.opencodeSource.targets[${index}] 必须为对象`);
  }
  const mode = text(source.mode);
  if (!SOURCE_MODES.has(mode)) {
    throw new Error(`OpenCode 来源模式仅支持 harmonyBot 或 softwareEngineering: ${mode || "<empty>"}`);
  }
  const root = text(source.root);
  if (!root) throw new Error(`Agent 目标 ${source.id || mode} 缺少 root`);
  const id = targetId(source.id, mode);
  if (multiple && !text(source.id)) {
    throw new Error(`多 Agent 配置必须为每个 target 显式设置唯一 id（缺失位置: targets[${index}]）`);
  }
  return {
    id,
    label: text(source.label) || id,
    mode,
    root: path.resolve(baseDir, root),
    agent: mode === "softwareEngineering" ? "build" : (text(source.agent) || text(defaultAgent)),
  };
}

/**
 * Normalize the legacy single-source object and the serial multi-target shape.
 * The returned target list is always explicit and ordered.
 */
export function normalizeAgentTargets(source, { baseDir = process.cwd(), defaultAgent = "" } = {}) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("缺少 server.opencodeSource 配置");
  }
  const hasTargets = Array.isArray(source.targets);
  const rawTargets = hasTargets ? source.targets : [source];
  if (!rawTargets.length) throw new Error("server.opencodeSource.targets 不能为空");
  const multiple = rawTargets.length > 1;
  const strategy = text(source.strategy) || "serial";
  if (hasTargets && strategy !== "serial") {
    throw new Error(`server.opencodeSource.strategy 仅支持 serial: ${strategy}`);
  }
  const targets = rawTargets.map((item, index) => normalizeSource(item, {
    baseDir,
    defaultAgent,
    index,
    multiple,
  }));
  const duplicate = targets.find((item, index) => targets.findIndex((other) => other.id === item.id) !== index);
  if (duplicate) throw new Error(`Agent 目标 id 重复: ${duplicate.id}`);
  for (const target of targets) {
    if (!target.agent) throw new Error(`Agent 目标 ${target.id} 未配置 agent`);
  }
  return {
    strategy: "serial",
    continueOnTargetError: source.continueOnTargetError !== false,
    targets,
    multiple,
    legacy: !hasTargets,
  };
}

export function normalizeGenerationModel(execution = {}, { requireProvider = false } = {}) {
  const model = text(execution.modelId || execution.model);
  if (text(execution.modelId) && text(execution.model) && text(execution.modelId) !== text(execution.model)) {
    throw new Error(`execution.model 与 execution.modelId 不一致: ${execution.model} / ${execution.modelId}`);
  }
  if (!model) throw new Error("未配置 execution.model（或 execution.modelId）");
  const providerId = text(execution.providerId);
  if (requireProvider && !providerId) {
    throw new Error("多 Agent 对比必须配置 execution.providerId，以保证所有 Agent 使用同一 Provider/模型");
  }
  return { providerId, modelId: model };
}

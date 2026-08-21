import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeWhiteboxConfig } from "../validation/whitebox-orchestrator.mjs";

const AUTORUN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUTPUT_ROOT = path.join(AUTORUN_ROOT, "output");

function resolveFrom(baseDir, value) {
  return value ? path.resolve(baseDir, value) : "";
}

export async function loadAutorunConfig(configPath = "./config/autorun.config.json") {
  const absolutePath = path.resolve(configPath);
  if (path.extname(absolutePath).toLowerCase() !== ".json") {
    throw new Error(`Autorun 配置必须为 JSON 文件: ${absolutePath}`);
  }
  let config;
  try {
    config = JSON.parse(await fs.readFile(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON: ${absolutePath}: ${error.message}`);
  }
  if (!config || typeof config !== "object") {
    throw new Error(`配置文件必须为 JSON 对象: ${absolutePath}`);
  }
  const baseDir = path.dirname(absolutePath);
  const normalized = structuredClone(config);
  normalized.__configPath = absolutePath;
  normalized.__baseDir = baseDir;
  normalized.server ||= {};
  normalized.execution ||= {};
  const source = normalized.server.opencodeSource;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("缺少 server.opencodeSource 配置");
  }
  normalized.server.opencodeSource = {
    mode: String(source.mode || "").trim(),
    root: resolveFrom(baseDir, source.root || ""),
  };
  normalized.server.loadAgents = Array.isArray(normalized.server.loadAgents)
    ? normalized.server.loadAgents.map((a) => String(a).trim()).filter(Boolean)
    : [];
  normalized.execution.casesRoot = resolveFrom(baseDir, normalized.execution.casesRoot || "./cases");
  normalized.execution.outputRoot = resolveFrom(
    baseDir,
    normalized.execution.outputRoot || OUTPUT_ROOT,
  );
  normalized.server.runtimeRoot = resolveFrom(
    baseDir,
    normalized.server.runtimeRoot || path.join(normalized.execution.outputRoot, "_runtime", "opencode"),
  );
  normalized.whiteboxEvaluation = normalizeWhiteboxConfig(
    normalized.whiteboxEvaluation,
    normalized.execution.outputRoot,
  );
  normalized.upload = { enabled: normalized.upload?.enabled === true };
  return normalized;
}

// 健康检查：loadAgents 非空时，校验 execution.agent 必须在其列表中。
// 校验不通过直接抛错中断，提示用户修改配置。
export function checkLoadAgents(config) {
  const loadAgents = Array.isArray(config?.server?.loadAgents) ? config.server.loadAgents : [];
  if (!loadAgents.length) return;
  const agent = String(config?.execution?.agent || "").trim();
  if (agent && !loadAgents.includes(agent)) {
    throw new Error(
      `execution.agent "${agent}" 不在 server.loadAgents [${loadAgents.join(", ")}] 中。` +
      `请修改 config/autorun.config.json：将 "${agent}" 加入 server.loadAgents，或清空 loadAgents 数组以加载全部 Agent。`,
    );
  }
}



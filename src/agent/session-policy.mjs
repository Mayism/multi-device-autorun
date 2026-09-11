export const AGENT_AUTO_APPROVAL_POLICY_MARKER = "# 无人值守确认策略（强制）";

export const AGENT_AUTO_APPROVAL_POLICY = `${AGENT_AUTO_APPROVAL_POLICY_MARKER}

- 当前任务执行所需操作均已授权；不得停下来等待用户确认。
- 如工具仍要求确认，统一选择允许、同意、继续执行或推荐方案。
- 如存在多个合理实现且没有额外业务信息，采用推荐方案或最稳妥的默认方案继续完成任务。`;

export function applyAgentSessionPolicy(rawConfig, { agentName, policy = AGENT_AUTO_APPROVAL_POLICY } = {}) {
  const name = String(agentName || "").trim();
  if (!name) throw new Error("注入会话策略时缺少 Agent 名称");
  const config = rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig) ? rawConfig : {};
  const agents = config.agent && typeof config.agent === "object" && !Array.isArray(config.agent)
    ? config.agent
    : {};
  const current = agents[name] && typeof agents[name] === "object" && !Array.isArray(agents[name])
    ? agents[name]
    : {};
  const existingPrompt = String(current.prompt || "").trim();
  const sessionPolicy = String(policy || "").trim();
  config.agent = agents;
  config.agent[name] = {
    ...current,
    prompt: [existingPrompt, sessionPolicy].filter(Boolean).join("\n\n"),
  };
  return config;
}

export function hasAgentSessionPolicy(config, agentName) {
  const prompt = String(config?.agent?.[agentName]?.prompt || "");
  return prompt.includes(AGENT_AUTO_APPROVAL_POLICY_MARKER);
}

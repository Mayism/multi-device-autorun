export function permissionPolicyAllowsEverything(policy) {
  if (policy === "allow") return true;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false;
  if (policy["*"] !== "allow") return false;

  const stack = [policy];
  while (stack.length) {
    const current = stack.pop();
    for (const value of Object.values(current)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        stack.push(value);
      } else if (value === "ask" || value === "deny") {
        return false;
      }
    }
  }
  return true;
}

export function serverAllowsEverything(config, agentName = "") {
  if (!permissionPolicyAllowsEverything(config?.permission)) return false;
  const agentPermission = config?.agent?.[agentName]?.permission;
  return agentPermission === undefined || permissionPolicyAllowsEverything(agentPermission);
}

export function forceAllowEverything(rawConfig, loadAgents = []) {
  const config = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  config.permission = "allow";

  const missingAgents = [];
  if (config.agent && typeof config.agent === "object" && !Array.isArray(config.agent)) {
    const selected = loadAgents.length ? {} : config.agent;
    const names = loadAgents.length ? loadAgents : Object.keys(config.agent);
    for (const name of names) {
      if (!Object.prototype.hasOwnProperty.call(config.agent, name)) {
        missingAgents.push(name);
        continue;
      }
      const agent = config.agent[name];
      const normalized = agent && typeof agent === "object" ? agent : {};
      normalized.permission = { "*": "allow" };
      if (loadAgents.length) selected[name] = normalized;
    }
    config.agent = selected;
  } else if (loadAgents.length) {
    missingAgents.push(...loadAgents);
  }

  return { config, missingAgents };
}

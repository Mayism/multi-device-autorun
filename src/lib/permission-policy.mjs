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

export function forceAllowEverything(rawConfig) {
  const config = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  config.permission = "allow";
  if (config.agent && typeof config.agent === "object" && !Array.isArray(config.agent)) {
    for (const agent of Object.values(config.agent)) {
      const normalized = agent && typeof agent === "object" ? agent : {};
      normalized.permission = { "*": "allow" };
    }
  }
  return config;
}

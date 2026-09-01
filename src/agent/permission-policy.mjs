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

// Autorun 允许对 Skill 做来源白名单限制，但其余工具仍必须保持完全允许。
// OpenCode 会用 permission.skill 过滤暴露给 Agent 的 Skill，因此这里忽略
// skill 子树中的 deny，只检查所有其他权限没有 ask/deny。
export function permissionPolicyAllowsExecution(policy) {
  if (policy === "allow") return true;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false;
  if (policy["*"] !== "allow") return false;

  const stack = [policy];
  while (stack.length) {
    const current = stack.pop();
    for (const [key, value] of Object.entries(current)) {
      if (current === policy && key === "skill") continue;
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

export function serverAllowsExecution(config, agentName = "") {
  if (!permissionPolicyAllowsExecution(config?.permission)) return false;
  const agentPermission = config?.agent?.[agentName]?.permission;
  return agentPermission === undefined || permissionPolicyAllowsExecution(agentPermission);
}

function skillAllowlistPermission(skillNames) {
  const skill = { "*": "deny" };
  for (const name of [...new Set(skillNames)].sort()) skill[name] = "allow";
  return { "*": "allow", skill };
}

export function forceAllowEverything(rawConfig, { allowedSkills } = {}) {
  const config = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const permission = Array.isArray(allowedSkills)
    ? skillAllowlistPermission(allowedSkills)
    : "allow";
  config.permission = permission;
  if (config.agent && typeof config.agent === "object" && !Array.isArray(config.agent)) {
    for (const agent of Object.values(config.agent)) {
      const normalized = agent && typeof agent === "object" ? agent : {};
      normalized.permission = Array.isArray(allowedSkills)
        ? skillAllowlistPermission(allowedSkills)
        : { "*": "allow" };
    }
  }
  return config;
}

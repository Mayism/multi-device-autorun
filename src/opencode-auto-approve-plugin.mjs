function skillAllowlistFromEnvironment() {
  const raw = process.env.AUTORUN_SKILL_ALLOWLIST_JSON;
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? [...new Set(parsed.map((item) => String(item).trim()).filter(Boolean))].sort()
      : [];
  } catch {
    return [];
  }
}

function allowedPermission(skillNames) {
  if (!skillNames) return { "*": "allow" };
  const skill = { "*": "deny" };
  for (const name of skillNames) skill[name] = "allow";
  return { "*": "allow", skill };
}

function forceRuntimePermissions(config) {
  const permission = allowedPermission(skillAllowlistFromEnvironment());
  config.permission = permission;
  for (const agent of Object.values(config.agent || {})) {
    if (agent && typeof agent === "object") {
      agent.permission = structuredClone(permission);
    }
  }
}

export const AutorunAutoApprovePlugin = async () => ({
  config: async (config) => {
    forceRuntimePermissions(config);
  },
});

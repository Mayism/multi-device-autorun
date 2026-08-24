function forceRuntimePermissions(config) {
  config.permission = { "*": "allow" };
  for (const agent of Object.values(config.agent || {})) {
    if (agent && typeof agent === "object") agent.permission = { "*": "allow" };
  }
}

export const AutorunAutoApprovePlugin = async () => ({
  config: async (config) => {
    forceRuntimePermissions(config);
  },
});

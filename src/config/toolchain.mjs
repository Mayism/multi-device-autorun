import process from "node:process";

const DEFAULT_TOOL_COMMANDS = Object.freeze({
  node: process.execPath,
  hvigorw: "hvigorw",
  ohpm: "ohpm",
});

function configuredValue(value) {
  return String(value || "").trim();
}

export function resolveSharedToolchain(config) {
  const server = config?.server && typeof config.server === "object" ? config.server : {};
  const legacyOhosPaths = config?.ohosTest?.paths && typeof config.ohosTest.paths === "object"
    ? config.ohosTest.paths
    : {};
  return {
    node: configuredValue(server.node)
      || configuredValue(legacyOhosPaths.node)
      || DEFAULT_TOOL_COMMANDS.node,
    // server 是共享工具的唯一推荐配置入口；继续兼容历史 ohosTest.paths 写法。
    hvigorw: configuredValue(server.hvigorw)
      || configuredValue(legacyOhosPaths.hvigorw)
      || DEFAULT_TOOL_COMMANDS.hvigorw,
    ohpm: configuredValue(server.ohpm)
      || configuredValue(legacyOhosPaths.ohpm)
      || DEFAULT_TOOL_COMMANDS.ohpm,
    sdkHome: configuredValue(server.sdkHome),
    javaHome: configuredValue(server.javaHome),
  };
}

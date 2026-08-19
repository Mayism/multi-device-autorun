/** officialCodeLinter 节点的可注入配置，测试和本地调试会覆盖默认环境配置。 */
export type OfficialCodeLinterNodeDeps = {
  enabled?: boolean;
  runDir?: string;
  timeoutMs?: number;
  hvigorEnabled?: boolean;
  hvigorRunDir?: string;
  hvigorTimeoutMs?: number;
};

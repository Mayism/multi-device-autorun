// 默认启用规则包保持与历史实现一致，跨设备规则包由任务理解结果按需追加。
export const defaultEnabledRulePackIds = [
  "arkts-language",
  "arkts-performance",
  "arkui-extra",
] as const;

export const crossDeviceAdaptationRulePackId = "cross-device-adaptation";

function providerList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.providers)) return value.providers;
  if (Array.isArray(value?.data?.providers)) return value.data.providers;
  return [];
}
function modelIds(provider) {
  if (Array.isArray(provider?.models)) {
    return provider.models.map((model) => String(model?.id || model || ""));
  }
  return Object.keys(provider?.models || {});
}

export async function resolveConfiguredModel({
  client,
  config,
  providerId,
  modelId,
  directory,
  signal,
}) {
  const staticProviders = config?.provider || {};
  const staticMatches = Object.entries(staticProviders)
    .filter(([, provider]) => modelIds(provider).includes(modelId))
    .map(([id]) => id);

  let runtimeProviders = [];
  try {
    runtimeProviders = providerList(
      await client.getProviders(directory, 30, signal),
    );
  } catch {
    // 旧版 OpenCode 没有动态 Provider 接口时继续使用静态配置。
  }
  const runtimeMatches = runtimeProviders
    .filter((provider) => modelIds(provider).includes(modelId))
    .map((provider) => String(provider?.id || ""))
    .filter(Boolean);

  if (providerId) {
    const providerExists = Object.hasOwn(staticProviders, providerId)
      || runtimeProviders.some((provider) => provider?.id === providerId);
    if (!providerExists) {
      throw new Error(`Server 未配置指定 Provider: ${providerId}`);
    }
    if (!staticMatches.includes(providerId) && !runtimeMatches.includes(providerId)) {
      throw new Error(`Server Provider ${providerId} 未配置模型: ${modelId}`);
    }
    return { providerId, modelId };
  }

  const matches = [...new Set([...staticMatches, ...runtimeMatches])];
  if (matches.length === 1) return { providerId: matches[0], modelId };
  if (matches.length > 1) {
    throw new Error(
      `模型 ${modelId} 同时存在于多个 Provider（${matches.join(", ")}），请配置 execution.providerId`,
    );
  }
  throw new Error(`Server 未配置模型: ${modelId}`);
}

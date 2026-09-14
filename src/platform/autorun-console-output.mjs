function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function formatEnvironmentCheck(failures = []) {
  const uniqueFailures = [...new Set(failures.map(compact).filter(Boolean))];
  if (!uniqueFailures.length) return "环境检查：通过";
  return [
    "环境检查：失败",
    ...uniqueFailures.map((failure) => `- ${failure}`),
  ].join("\n");
}

export function formatRunConfiguration({ agent, providerId, modelId }) {
  const model = [compact(providerId), compact(modelId)].filter(Boolean).join("/");
  return `运行配置：Agent=${compact(agent) || "--"}；模型=${model || "--"}`;
}

export function writeAutorunStartupSummary(
  { failures = [], agent, providerId, modelId },
  write = (value) => process.stdout.write(value),
) {
  write(`${formatEnvironmentCheck(failures)}\n`);
  write(`${formatRunConfiguration({ agent, providerId, modelId })}\n`);
}

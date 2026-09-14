import { createServer } from "node:net";

const DEFAULT_HOST = "127.0.0.1";
const MIN_HDC_PORT = 10000;
const MAX_HDC_PORT = 16555;

export function canBindTcpPort(port, host = DEFAULT_HOST) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => resolve(!error));
    });
  });
}

async function findRecommendedPort({
  configuredPort,
  reservedPorts,
  probePort,
  minPort,
  maxPort,
}) {
  const candidateCount = maxPort - minPort + 1;
  for (let offset = 1; offset <= candidateCount; offset += 1) {
    const candidate = minPort + ((configuredPort - minPort + offset) % candidateCount);
    if (reservedPorts.has(candidate)) continue;
    if (!await probePort(candidate, DEFAULT_HOST)) continue;
    reservedPorts.add(candidate);
    return candidate;
  }
  return null;
}

export async function checkConfiguredEmulatorPorts(
  machineConfig,
  {
    probePort = canBindTcpPort,
    minPort = MIN_HDC_PORT,
    maxPort = MAX_HDC_PORT,
  } = {},
) {
  const devices = (Array.isArray(machineConfig?.devices) ? machineConfig.devices : [])
    .filter((device) => device?.startEmulator === true && Number.isInteger(device?.hdcPort));
  const reservedPorts = new Set(
    (Array.isArray(machineConfig?.devices) ? machineConfig.devices : [])
      .map((device) => device?.hdcPort)
      .filter(Number.isInteger),
  );
  const conflicts = [];

  for (const device of devices) {
    if (await probePort(device.hdcPort, DEFAULT_HOST)) continue;
    const recommendedPort = await findRecommendedPort({
      configuredPort: device.hdcPort,
      reservedPorts,
      probePort,
      minPort,
      maxPort,
    });
    conflicts.push({
      id: String(device.id || "unknown"),
      profile: String(device.profile || ""),
      port: device.hdcPort,
      recommendedPort,
    });
  }
  return conflicts;
}

export function formatEmulatorPortConflict(conflict) {
  const device = conflict.profile
    ? `${conflict.id}（${conflict.profile}）`
    : conflict.id;
  if (!Number.isInteger(conflict.recommendedPort)) {
    return `模拟器 ${device}：HDC 端口 ${conflict.port} 已被占用，未找到可推荐的空闲端口`;
  }
  return [
    `模拟器 ${device}：HDC 端口 ${conflict.port} 已被占用`,
    `推荐同时将 target 改为 ${DEFAULT_HOST}:${conflict.recommendedPort}、hdcPort 改为 ${conflict.recommendedPort}`,
  ].join("；");
}

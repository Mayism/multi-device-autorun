import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import { createApp } from "./api/app.js";
import { getConfig } from "./config.js";
import { stopServiceOpencodeRunnerPool } from "./service/index.js";

export * from "./api/app.js";

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const config = getConfig();
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`hmos-score-agent API 已启动，监听端口：${config.port}`);
  });
  installShutdownHandlers(server);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && "code" in error && error.code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function installShutdownHandlers(server: Server): void {
  let shuttingDown = false;

  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) {
      process.exit(1);
    }
    shuttingDown = true;

    console.log(`hmos-score-agent API 收到 ${signal}，正在停止服务和 opencode server`);
    try {
      await Promise.all([closeServer(server), stopServiceOpencodeRunnerPool()]);
      process.exit(0);
    } catch (error) {
      console.error(
        `hmos-score-agent API 停止失败：${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  }

  process.once("SIGINT", (signal) => {
    void shutdown(signal);
  });
  process.once("SIGTERM", (signal) => {
    void shutdown(signal);
  });
}

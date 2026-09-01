import net from "node:net";

const FOLD_SERVER_START_PORT = 8766;
const FOLD_SERVER_MAX_ATTEMPTS = 100;

export async function findAvailableFoldServerPort(
  isAvailable: (port: number) => Promise<boolean> = isTcpPortAvailable,
  startPort: number = FOLD_SERVER_START_PORT,
  maxAttempts: number = FOLD_SERVER_MAX_ATTEMPTS,
): Promise<{ port: number; devicePort: number }> {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = startPort + offset;
    if (await isAvailable(port)) {
      return { port, devicePort: port - 1 };
    }
  }
  throw new Error("fold_server_port_unavailable");
}

export function isTcpPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => resolve(error === undefined));
    });
  });
}

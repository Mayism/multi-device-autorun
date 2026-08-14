import http from "node:http";

const HEALTH_CHECK_INTERVAL_MS = 500;
const HEALTH_CHECK_TIMEOUT_MS = 10000;

export async function healthCheck(
  port: number,
  timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS,
  ownerToken?: string,
  shouldContinue: () => boolean = () => true,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && shouldContinue()) {
    const ok = await checkHealthOnce(port, ownerToken);
    if (ok) {
      return true;
    }
    if (!shouldContinue()) return false;
    await new Promise((resolve) =>
      setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS),
    );
  }
  return false;
}

function checkHealthOnce(
  port: number,
  ownerToken?: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(
      `http://127.0.0.1:${port}/health`,
      { timeout: HEALTH_CHECK_INTERVAL_MS },
      (response) => {
        if (response.statusCode !== 200 || ownerToken === undefined) {
          resolve(response.statusCode === 200);
          response.resume();
          return;
        }
        let body = "";
        response.setEncoding("utf-8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            const payload = JSON.parse(body) as { ownerToken?: string };
            resolve(payload.ownerToken === ownerToken);
          } catch {
            resolve(false);
          }
        });
      },
    );
    request.on("error", () => {
      resolve(false);
    });
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });
}

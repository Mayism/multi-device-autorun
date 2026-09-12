import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { assertRunning, type OwnedProcess } from "./process.js";

export async function assertPortFree(readyUrl: string): Promise<void> {
  const url = new URL(readyUrl);
  const host = url.hostname === "[::1]" ? "::1" : url.hostname;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) =>
      reject(
        new Error(`web_port_unavailable: ${host}:${port}: ${error.message}`),
      ),
    );
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

export async function waitForWebReady(input: {
  process: OwnedProcess;
  url: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    input.signal.throwIfAborted();
    assertRunning(input.process);
    if (
      await isHttpReady(
        input.url,
        Math.min(1000, deadline - Date.now()),
        input.signal,
      )
    ) {
      await sleep(100, undefined, { signal: input.signal });
      assertRunning(input.process);
      return;
    }
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())), undefined, {
      signal: input.signal,
    });
  }
  throw new Error(`web_server_not_ready: ${input.url}`);
}

async function isHttpReady(
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.max(1, timeoutMs)),
      ]),
      redirect: "error",
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

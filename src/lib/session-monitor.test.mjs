import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runMonitoredSession } from "./session-monitor.mjs";

test("session.error fails immediately instead of waiting for the idle timeout", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-session-monitor-"));
  const projectDir = path.join(tempDir, "project");
  await fs.mkdir(projectDir);
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  const sessionId = "session-with-plugin-error";
  const server = http.createServer((request, response) => {
    if (!request.url?.startsWith("/global/event")) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(`data: ${JSON.stringify({
      directory: projectDir,
      payload: {
        type: "session.error",
        properties: {
          sessionID: sessionId,
          error: { data: { message: "plugin hook crashed" } },
        },
      },
    })}\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  let aborted = false;
  const address = server.address();
  const client = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    promptAsync: async () => {},
    abortSession: async () => { aborted = true; },
  };
  const startedAt = Date.now();

  await assert.rejects(
    runMonitoredSession({
      client,
      sessionId,
      projectDir,
      payload: { parts: [{ type: "text", text: "test" }] },
      eventsPath: path.join(tempDir, "events.jsonl"),
      pollingPath: path.join(tempDir, "polling.jsonl"),
      idleTimeoutSec: 30,
      maxRuntimeSec: 30,
    }),
    (error) => {
      assert.equal(error.code, "OPENCODE_SESSION_ERROR");
      assert.match(error.message, /plugin hook crashed/);
      return true;
    },
  );

  assert.equal(aborted, true);
  assert.ok(Date.now() - startedAt < 3000);
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  requestsBasicTestsReply,
  runMonitoredSession,
} from "./session-monitor.mjs";

async function createTestWorkspace(t) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "autorun-session-monitor-"));
  const projectDir = path.join(tempDir, "project");
  await fs.mkdir(projectDir);
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  return { tempDir, projectDir };
}

// 启动一个假 OpenCode SSE 服务：每次 /global/event 连接都推送给定事件。
function startFakeEventServer(projectDir, payloads) {
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
    for (const payload of payloads) {
      response.write(`data: ${JSON.stringify({ directory: projectDir, payload })}\n\n`);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        close: () => new Promise((resolveClose, rejectClose) => {
          server.close((error) => (error ? rejectClose(error) : resolveClose()));
        }),
        client: {
          baseUrl: `http://127.0.0.1:${address.port}`,
          promptAsync: async () => {},
        },
      });
    });
  });
}

test("session.error fails immediately instead of waiting for the idle timeout", async (t) => {
  const { tempDir, projectDir } = await createTestWorkspace(t);
  const sessionId = "session-with-plugin-error";
  const fake = await startFakeEventServer(projectDir, [{
    type: "session.error",
    properties: {
      sessionID: sessionId,
      error: { data: { message: "plugin hook crashed" } },
    },
  }]);
  t.after(() => fake.close());

  let aborted = false;
  fake.client.abortSession = async () => { aborted = true; };
  const startedAt = Date.now();

  await assert.rejects(
    runMonitoredSession({
      client: fake.client,
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

test("hard usage-cap retry aborts the session immediately with rate-limit error", async (t) => {
  const { tempDir, projectDir } = await createTestWorkspace(t);
  const sessionId = "session-quota-hard";
  const quotaMessage = "您已达到每周/每月使用上限，您的限额将在 2026-08-26 10:01:54 重置。";
  const notifications = [];
  const fake = await startFakeEventServer(projectDir, [{
    type: "session.status",
    properties: {
      sessionID: sessionId,
      status: { type: "retry", attempt: 1, message: quotaMessage },
    },
  }]);
  t.after(() => fake.close());

  let aborted = false;
  fake.client.abortSession = async () => { aborted = true; };
  const startedAt = Date.now();

  await assert.rejects(
    runMonitoredSession({
      client: fake.client,
      sessionId,
      projectDir,
      payload: { parts: [{ type: "text", text: "test" }] },
      eventsPath: path.join(tempDir, "events.jsonl"),
      pollingPath: path.join(tempDir, "polling.jsonl"),
      idleTimeoutSec: 30,
      maxRuntimeSec: 30,
      onQuotaExceeded: (message, hard) => notifications.push({ message, hard }),
    }),
    (error) => {
      assert.equal(error.code, "AGENT_QUOTA_EXCEEDED");
      assert.equal(error.quotaLimited, true);
      assert.match(error.message, /使用上限/);
      return true;
    },
  );

  assert.equal(aborted, true);
  assert.deepEqual(notifications, [{ message: quotaMessage, hard: true }]);
  assert.ok(Date.now() - startedAt < 3000);
});

test("transient rate-limit retry keeps waiting and still marks quotaLimited", async (t) => {
  const { tempDir, projectDir } = await createTestWorkspace(t);
  const sessionId = "session-quota-soft";
  const notifications = [];
  const fake = await startFakeEventServer(projectDir, [{
    type: "session.status",
    properties: {
      sessionID: sessionId,
      status: { type: "retry", attempt: 1, message: "rate limit exceeded, retrying in 4s" },
    },
  }]);
  t.after(() => fake.close());

  let aborted = false;
  fake.client.abortSession = async () => { aborted = true; };
  const startedAt = Date.now();

  // 瞬时限流不主动终止：等待 server 自行重试，此处用极短 idle 超时收尾。
  await assert.rejects(
    runMonitoredSession({
      client: fake.client,
      sessionId,
      projectDir,
      payload: { parts: [{ type: "text", text: "test" }] },
      eventsPath: path.join(tempDir, "events.jsonl"),
      pollingPath: path.join(tempDir, "polling.jsonl"),
      idleTimeoutSec: 1,
      maxRuntimeSec: 10,
      onQuotaExceeded: (message, hard) => notifications.push({ message, hard }),
    }),
    (error) => {
      assert.match(error.message, /无活动|总运行时间超过/);
      assert.equal(error.quotaLimited, true);
      assert.notEqual(error.code, "AGENT_QUOTA_EXCEEDED");
      return true;
    },
  );

  assert.equal(aborted, true);
  assert.deepEqual(notifications, [{ message: "rate limit exceeded, retrying in 4s", hard: false }]);
  assert.ok(Date.now() - startedAt < 6000);
});

test("requestsBasicTestsReply matches only the multimodal fallback guidance", () => {
  const message = (text) => ({
    info: { role: "assistant" },
    parts: [{ type: "text", text }],
  });
  assert.equal(
    requestsBasicTestsReply(
      message("当前模型未通过图片理解探测，请选择后续测试方式：请回复“仅基础测试”。"),
    ),
    true,
  );
  assert.equal(requestsBasicTestsReply(message("仅基础测试已经执行完成。")), false);
  assert.equal(
    requestsBasicTestsReply(message("当前模型未通过图片理解探测，但无需用户回复。")),
    false,
  );
});

test("multimodal fallback text receives one basic-tests reply in the same session", async (t) => {
  const { tempDir, projectDir } = await createTestWorkspace(t);
  const sessionId = "session-multimodal-fallback";
  const fake = await startFakeEventServer(projectDir, [{
    type: "session.idle",
    properties: { sessionID: sessionId },
  }]);
  t.after(() => fake.close());

  const prompts = [];
  const progress = [];
  const terminalMessage = (id, text) => ({
    info: { id, role: "assistant", finish: "stop" },
    parts: [
      { type: "text", text },
      { type: "step-finish" },
    ],
  });
  fake.client.promptAsync = async (_sessionId, payload) => {
    prompts.push(payload);
  };
  fake.client.listMessages = async () => [
    prompts.length === 1
      ? terminalMessage(
          "first",
          "当前模型未通过图片理解探测，请选择后续测试方式：\n1. 仅基础测试（默认方案）。请回复“仅基础测试”。\n2. 继续多模态测试。",
        )
      : terminalMessage("second", "基础测试已完成。"),
  ];
  fake.client.listChildren = async () => [];
  fake.client.listTodos = async () => [];
  fake.client.listQuestions = async () => [];
  fake.client.listPermissions = async () => [];
  fake.client.abortSession = async () => {};

  const initialPayload = {
    parts: [{ type: "text", text: "执行一多适配" }],
    agent: "harmonyos-multi-device",
    model: { providerID: "provider", modelID: "model" },
  };
  const result = await runMonitoredSession({
    client: fake.client,
    sessionId,
    projectDir,
    payload: initialPayload,
    eventsPath: path.join(tempDir, "events.jsonl"),
    pollingPath: path.join(tempDir, "polling.jsonl"),
    idleTimeoutSec: 10,
    maxRuntimeSec: 15,
    onProgress: (event, data) => progress.push({ event, data }),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.output, "基础测试已完成。");
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts[1], {
    ...initialPayload,
    parts: [{ type: "text", text: "仅基础测试" }],
  });
  assert.deepEqual(
    progress.filter(({ event }) => event === "text_replied").map(({ data }) => data),
    [{
      sessionId,
      text: "仅基础测试",
      reason: "multimodal_unavailable",
    }],
  );
  const polling = await fs.readFile(path.join(tempDir, "polling.jsonl"), "utf8");
  assert.equal((polling.match(/"kind":"automatic_text_reply"/g) ?? []).length, 1);
});

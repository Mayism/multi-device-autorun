import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONTINUE_TASK_REPLY } from "./text-confirmation.mjs";
import {
  requestsBasicTestsReply,
  runMonitoredSession,
} from "./session-monitor.mjs";

const MULTIMODAL_FALLBACK = "当前模型未通过图片理解探测（无法读取图片附件），请选择后续测试方式：\n\n1. **仅基础测试（默认方案）**：保留构建和静态检查结果，多模态测试（设备截图视觉判定）标记为未验证，继续生成报告。请回复“**仅基础测试**”。\n2. **继续多模态测试**：请先切换到支持图片理解的模型，再回复“**切换完，继续执行多模态测试**”。";

const MULTIMODAL_PROBE_FAILURE = `多模态探测未通过（当前模型不支持图片理解）。按验证流程需要您选择后续测试方式：

> **1. 仅基础测试（默认方案）**：保留构建和静态检查结果，多模态测试标记为未验证，继续生成报告。请回复“仅基础测试”。
>
> **2. 继续多模态测试**：请先切换到支持图片理解的模型，再回复“切换完，继续执行多模态测试”。`;

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
  assert.equal(
    requestsBasicTestsReply(
      message("当前模型未通过图片理解探测（无法读取图片附件），请选择后续测试方式：请回复“**仅基础测试**”。"),
    ),
    true,
  );
  assert.equal(requestsBasicTestsReply(message("仅基础测试已经执行完成。")), false);
  assert.equal(requestsBasicTestsReply(message(MULTIMODAL_FALLBACK)), true);
  assert.equal(requestsBasicTestsReply(message(MULTIMODAL_PROBE_FAILURE)), true);
  assert.equal(requestsBasicTestsReply(message("多模态探测未通过，请回复“仅基础测试”。")), true);
  assert.equal(requestsBasicTestsReply(message("当前模型不支持图片理解，请回复“仅基础测试”。")), true);
  assert.equal(requestsBasicTestsReply(message("多模态探测已通过。请回复“仅基础测试”。")), false);
  assert.equal(requestsBasicTestsReply(message("构建未通过，请回复“仅基础测试”。")), false);
  assert.equal(
    requestsBasicTestsReply(message("当前模型未通过图片理解探测，但无需用户回复。")),
    false,
  );
});

test("multimodal fallback recognizes varied confirmation wording without a fixed reply instruction", () => {
  const matches = text => requestsBasicTestsReply({ parts: [{ type: "text", text }] });
  for (const text of [
    "多模态探测未通过，请选择：1. 仅基础测试；2. 切换模型后继续。",
    "当前模型不支持图片理解，是否继续基础测试？",
    "图片理解能力不足，是否降级为基础验证？",
    "无法读取图片附件。请选择后续测试方式：\n> 1. 基础测试\n> 2. 多模态测试",
    "图片看不了，要不要先跑不依赖截图的检查？",
    "无法看图，只做基础检查可以吗？",
    "当前模型无法理解截图。是否仅保留构建和静态检查？",
    "图像理解检测失败，需要您确认后续方案：\n只执行基础测试\n切换模型",
    "模型不具备视觉理解能力，您是否同意仅做基础测试并生成报告？",
    "当前模型不支持图片输入，继续基础测试？",
    "无法看图，您想继续基础检查吗？",
    "多模态探测失败。是否继续？\n1. 基础测试\n2. 切换模型进行多模态测试",
  ]) assert.equal(matches(text), true, text);
  for (const text of [
    "图片理解能力不足，已降级为基础测试并生成报告。",
    "当前模型不支持图片理解。基础测试已经完成。请选择报告格式。",
    "当前模型不支持图片理解。基础测试已经完成。请选择报告方案。",
    "当前模型不支持图片理解，是否切换模型？",
    "多模态探测已通过，是否继续基础测试？",
    "编译失败，是否继续基础测试？",
    "图片加载失败，是否继续基础测试？",
    "如果当前模型不支持图片理解，请选择仅基础测试。",
    "当前模型不支持图片理解，无需确认是否继续基础测试，我将自动生成报告。",
    "当前模型不支持图片理解，不用回复仅基础测试。",
  ]) assert.equal(matches(text), false, text);
});

for (const completionShape of ["completed-time", "part-reason"]) {
  test(`multimodal reply accepts ${completionShape} completion metadata`, async (t) => {
    const { tempDir, projectDir } = await createTestWorkspace(t);
    const sessionId = `fallback-${completionShape}`;
    const fake = await startFakeEventServer(projectDir, [{
      type: "session.idle", properties: { sessionID: sessionId },
    }]);
    t.after(() => fake.close());
    const prompts = [];
    fake.client.promptAsync = async (_id, payload) => prompts.push(payload);
    fake.client.listMessages = async () => [{
      info: {
        id: prompts.length === 1 ? "request" : "done", role: "assistant",
        ...(completionShape === "completed-time" ? { finish: "stop", time: { completed: 123 } } : {}),
      },
      parts: [
        { type: "text", text: prompts.length === 1 ? MULTIMODAL_FALLBACK : "基础测试完成。" },
        ...(completionShape === "part-reason" ? [{ type: "step-finish", reason: "stop" }] : []),
      ],
    }];
    fake.client.listChildren = async () => [];
    fake.client.listTodos = async () => [];
    fake.client.listQuestions = async () => [];
    fake.client.listPermissions = async () => [];
    fake.client.abortSession = async () => {};
    const result = await runMonitoredSession({
      client: fake.client, sessionId, projectDir,
      payload: { parts: [{ type: "text", text: "执行适配" }] },
      eventsPath: path.join(tempDir, "events.jsonl"),
      pollingPath: path.join(tempDir, "polling.jsonl"),
      idleTimeoutSec: 3, maxRuntimeSec: 10,
    });
    assert.equal(prompts.length, 2);
    assert.equal(prompts[1].parts[0].text, "仅基础测试");
    assert.equal(result.output, "基础测试完成。");
  });
}

for (const workflow of [false, true]) {
test(`${workflow ? "workflow" : "multimodal"} requests are answered per message and stale polls cannot finish the resumed session`, async (t) => {
  const { tempDir, projectDir } = await createTestWorkspace(t);
  const sessionId = "repeated-fallback";
  const fake = await startFakeEventServer(projectDir, []);
  t.after(() => fake.close());
  const prompts = [];
  let stalePolls = 0;
  fake.client.promptAsync = async (_id, payload) => prompts.push(payload);
  fake.client.listMessages = async () => {
    const id = prompts.length === 1 || (prompts.length === 2 && stalePolls++ < 2)
      ? "request-one" : prompts.length === 2 ? "request-two" : "done";
    return [{
      info: { id, role: "assistant", finish: "stop" },
      parts: [
        { type: "text", text: id === "done" ? "适配报告已完成。" : workflow ? "是否继续进入下一阶段？" : MULTIMODAL_FALLBACK },
        { type: "step-finish" },
      ],
    }];
  };
  fake.client.listChildren = async () => [];
  fake.client.listTodos = async () => [];
  fake.client.listQuestions = async () => [];
  fake.client.listPermissions = async () => [];
  fake.client.abortSession = async () => {};
  const result = await runMonitoredSession({
    client: fake.client, sessionId, projectDir,
    payload: { parts: [{ type: "text", text: "执行适配" }] },
    eventsPath: path.join(tempDir, "events.jsonl"),
    pollingPath: path.join(tempDir, "polling.jsonl"),
    idleTimeoutSec: 10, maxRuntimeSec: 20,
  });
  assert.equal(prompts.length, 3);
  const expectedReply = workflow ? CONTINUE_TASK_REPLY : "仅基础测试";
  assert.deepEqual(prompts.slice(1).map(p => p.parts[0].text), [expectedReply, expectedReply]);
  assert.equal(result.output, "适配报告已完成。");
});
}

for (const workflow of [false, true]) {
test(`answering a ${workflow ? "workflow" : "multimodal"} Question waits for the resumed Agent result without another text reply`, async (t) => {
  const { tempDir, projectDir } = await createTestWorkspace(t);
  const sessionId = "question-fallback";
  const fake = await startFakeEventServer(projectDir, [{
    type: "session.idle", properties: { sessionID: sessionId },
  }]);
  t.after(() => fake.close());
  let answered = false;
  let stalePolls = 0;
  let promptCalls = 0;
  fake.client.promptAsync = async () => { promptCalls += 1; };
  const questionText = workflow ? "是否先生成高保真预览？" : "当前模型不支持图片理解，是否继续基础测试？";
  fake.client.listMessages = async () => {
    const done = answered && stalePolls++ >= 2;
    return [{
      info: { id: done ? "done" : "waiting", role: "assistant", finish: "stop" },
      parts: [
        { type: "text", text: done ? "基础测试报告已完成。" : questionText },
        { type: "step-finish" },
      ],
    }];
  };
  fake.client.listChildren = async () => [];
  fake.client.listTodos = async () => [];
  fake.client.listQuestions = async () => answered ? [] : [{
    id: "fallback-question", questions: [{
      question: questionText,
      options: workflow ? [{ label: "先生成高保真预览（推荐）" }, { label: "取消" }]
        : [{ label: "继续多模态测试" }, { label: "仅基础测试" }],
    }],
  }];
  fake.client.replyQuestion = async (_id, answers) => {
    assert.deepEqual(answers, [[workflow ? "先生成高保真预览（推荐）" : "仅基础测试"]]);
    answered = true;
  };
  fake.client.listPermissions = async () => [];
  fake.client.abortSession = async () => {};
  const result = await runMonitoredSession({
    client: fake.client, sessionId, projectDir,
    payload: { parts: [{ type: "text", text: "执行适配" }] },
    eventsPath: path.join(tempDir, "events.jsonl"),
    pollingPath: path.join(tempDir, "polling.jsonl"),
    idleTimeoutSec: 10, maxRuntimeSec: 15,
  });
  assert.equal(result.output, "基础测试报告已完成。");
  assert.equal(promptCalls, 1, "Question reply must not be followed by a duplicate text reply");
});
}

for (const scenario of [
  { name: "multimodal fallback", question: "图片看不了，要不要先跑不依赖截图的检查？", reply: "仅基础测试", reason: "multimodal_unavailable" },
  { name: "workflow confirmation", question: "1. 是否继续进入 **B02 导航框架**（全局 Tabs 导航栏 SM/MD 底部 ↔ LG/XL 左侧竖向 + 追剧页编辑按钮挪移）的 SPEC 生成与高保真预览？", reply: CONTINUE_TASK_REPLY, reason: "workflow_confirmation" },
  { name: "default confirmation without an action keyword", question: "是否采用推荐方案？", reply: CONTINUE_TASK_REPLY, reason: "workflow_confirmation" },
]) {
test(`${scenario.name} text receives one reply in the same session`, async (t) => {
  const { tempDir, projectDir } = await createTestWorkspace(t);
  const sessionId = "session-multimodal-fallback";
  const fake = await startFakeEventServer(projectDir, [{
    type: "session.idle",
    properties: { sessionID: sessionId },
  }]);
  t.after(() => fake.close());

  const prompts = [];
  const progress = [];
  let messagePolls = 0;
  let replySubmittedAtPoll = 0;
  const terminalMessage = (id, text) => ({
    info: { id, role: "assistant", finish: "stop" },
    parts: [
      { type: "text", text },
      { type: "step-finish" },
    ],
  });
  fake.client.promptAsync = async (_sessionId, payload) => {
    if (prompts.length === 1) replySubmittedAtPoll = messagePolls;
    prompts.push(payload);
  };
  fake.client.listMessages = async () => {
    messagePolls += 1;
    if (prompts.length !== 1) return [terminalMessage("second", "基础测试已完成。")];
    const text = scenario.question;
    if (messagePolls === 1) {
      return [{
        info: { id: "first", role: "assistant", finish: "tool-calls" },
        parts: [{ type: "text", text }],
      }];
    }
    return [terminalMessage("first", text)];
  };
  fake.client.listChildren = async () => [];
  // 真实工作流在等待这条用户回复时仍会保留活动 Todo，自动续话不应被它阻塞。
  fake.client.listTodos = async () => prompts.length === 1 ? [{ status: "in_progress" }] : [];
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
  assert.ok(replySubmittedAtPoll >= 2, "must wait until the matching assistant message is terminal");
  assert.deepEqual(prompts[1], {
    ...initialPayload,
    parts: [{ type: "text", text: scenario.reply }],
  });
  assert.deepEqual(
    progress.filter(({ event }) => event === "text_replied").map(({ data }) => data),
    [{
      sessionId,
      text: scenario.reply,
      reason: scenario.reason,
      sourceSessionId: sessionId,
      sourceMessageId: "first",
    }],
  );
  const polling = await fs.readFile(path.join(tempDir, "polling.jsonl"), "utf8");
  assert.equal((polling.match(/"kind":"automatic_text_reply"/g) ?? []).length, 1);
});
}

test("multimodal fallback emitted by a child is replied through the root session once", async (t) => {
  const { tempDir, projectDir } = await createTestWorkspace(t);
  const sessionId = "session-with-child-fallback";
  const childSessionId = "child-with-fallback";
  const workingChildSessionId = "child-still-working";
  const fake = await startFakeEventServer(projectDir, [{
    type: "session.idle",
    properties: { sessionID: sessionId },
  }]);
  t.after(() => fake.close());

  const promptCalls = [];
  const progress = [];
  const terminalMessage = (id, text) => ({
    info: { id, role: "assistant", finish: "stop" },
    parts: [
      { type: "text", text },
      { type: "step-finish" },
    ],
  });
  fake.client.promptAsync = async (targetSessionId, promptPayload) => {
    promptCalls.push({ targetSessionId, payload: promptPayload });
  };
  fake.client.listMessages = async (targetSessionId) => {
    if (targetSessionId === childSessionId) {
      return [terminalMessage(
        "child-request",
        "当前模型未通过图片理解探测，请选择后续测试方式：请回复“**仅基础测试**”。",
      )];
    }
    if (targetSessionId === workingChildSessionId) {
      return [promptCalls.length === 1
        ? {
            info: { id: "child-working", role: "assistant", finish: "tool-calls" },
            parts: [{ type: "reasoning", text: "其他子任务仍在执行。" }],
          }
        : terminalMessage("child-finished", "其他子任务已完成。")];
    }
    return [promptCalls.length === 1
      ? terminalMessage("root-waiting", "子任务已返回，是否继续进入下一阶段？")
      : terminalMessage("root-finished", "已按基础测试完成报告。")];
  };
  fake.client.listChildren = async () => [{ id: childSessionId }, { id: workingChildSessionId }];
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
  assert.equal(result.output, "已按基础测试完成报告。");
  assert.equal(promptCalls.length, 2);
  assert.equal(promptCalls[1].targetSessionId, sessionId);
  assert.deepEqual(promptCalls[1].payload, {
    ...initialPayload,
    parts: [{ type: "text", text: "仅基础测试" }],
  });
  assert.deepEqual(
    progress.filter(({ event }) => event === "text_replied").map(({ data }) => data),
    [{
      sessionId,
      text: "仅基础测试",
      reason: "multimodal_unavailable",
      sourceSessionId: childSessionId,
      sourceMessageId: "child-request",
    }],
  );
  const polling = await fs.readFile(path.join(tempDir, "polling.jsonl"), "utf8");
  assert.equal((polling.match(/"kind":"automatic_text_reply"/g) ?? []).length, 1);
});

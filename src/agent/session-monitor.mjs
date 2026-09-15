import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TokenUsageTracker } from "./token-usage.mjs";
import { CompileUsageTracker } from "./compile-usage.mjs";
import { handlePendingInteractions } from "./interaction-policy.mjs";

const TERMINAL_FINISH_EXCLUSIONS = new Set(["", "tool-calls", "unknown"]);
const ACTIVE_TODO_STATES = new Set(["pending", "in_progress", "in-progress", "running", "active", "doing", "todo"]);
const BASIC_TESTS_REPLY = "仅基础测试";

function walk(value, visitor) {
  if (!value || typeof value !== "object") return;
  visitor(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) walk(item, visitor);
}

// 识别模型侧 API 限额提示（如「您已达到每周/每月使用上限，您的限额将在 … 重置」、
// rate limit / quota exceeded / HTTP 429），用于把限额失败与普通失败区分开。
export function isQuotaExceededMessage(text) {
  return /使用上限|限额|rate\s*[-_]?limit|usage\s*limit|quota\s*(?:exceeded|limit)?|429/i.test(String(text || ""));
}

// 周期用量上限（每周/每月/使用上限/含重置时间）在重置点之前不会恢复，继续等待
// 只会耗到 idle 超时；瞬时限流（普通 429/rate limit）通常短时间内自行恢复，
// 仍交给 server 重试。导出以便分类侧与测试复用同一判断。
export function isHardQuotaCap(text) {
  return /每周|每月|使用上限|限额[^。；]{0,24}重置|weekly|monthly|usage\s*limit|(?:quota|limit)[^.;]{0,32}reset/i.test(String(text || ""));
}

function eventData(payload) {
  let current = payload;
  const visited = new Set();
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    if (current.payload && typeof current.payload === "object") {
      current = current.payload;
      continue;
    }
    if (current.data && typeof current.data === "object") {
      current = current.data;
      continue;
    }
    break;
  }
  return current;
}

function eventType(payload) {
  const data = eventData(payload);
  return String(data?.type || payload?.event || payload?.type || "").trim().toLowerCase();
}

function sessionError(payload) {
  const data = eventData(payload);
  const raw = data?.properties?.error || data?.error;
  const message = raw?.data?.message || raw?.message || (typeof raw === "string" ? raw : "");
  const error = new Error(`OpenCode session error${message ? `: ${message}` : ""}`);
  error.code = "OPENCODE_SESSION_ERROR";
  return error;
}

function collectSessionIds(payload) {
  const ids = new Set();
  walk(payload, (node) => {
    const candidate = node.sessionID || node.sessionId || node.session_id;
    if (candidate) ids.add(String(candidate));
  });
  return ids;
}

function collectDirectories(payload) {
  const directories = new Set();
  walk(payload, (node) => {
    if (typeof node.directory === "string") directories.add(path.resolve(node.directory));
  });
  return directories;
}

function latestAssistantMessage(payload) {
  const values = Array.isArray(payload) ? payload : payload ? [payload] : [];
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const item = values[index];
    if (!item || typeof item !== "object") continue;
    const role = String(item.info?.role || item.role || "").toLowerCase();
    if (!role || role === "assistant") return item;
  }
  return null;
}

function messageParts(message) {
  return Array.isArray(message?.parts) ? message.parts : [];
}

function extractText(message) {
  return messageParts(message)
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function requestsBasicTestsReply(message) {
  const text = extractText(message);
  return text.includes("当前模型未通过图片理解探测")
    && text.includes("仅基础测试")
    && /请回复[“\"']?仅基础测试[”\"']?/.test(text);
}

function followUpPayload(payload, text) {
  return {
    ...(payload && typeof payload === "object" ? payload : {}),
    parts: [{ type: "text", text }],
  };
}

function messageProgress(message) {
  let outputChars = 0;
  let reasoningChars = 0;
  let toolCalls = 0;
  let latestTool = null;
  let latestPreview = "";
  let latestPreviewType = "";

  for (const part of messageParts(message)) {
    const type = String(part?.type || "").toLowerCase();
    if (type === "text" && typeof part.text === "string") {
      outputChars += part.text.length;
      if (part.text.trim()) {
        latestPreview = part.text;
        latestPreviewType = "text";
      }
    }
    if (type === "reasoning" && typeof part.text === "string") {
      reasoningChars += part.text.length;
      if (part.text.trim()) {
        latestPreview = part.text;
        latestPreviewType = "reasoning";
      }
    }
    if (type === "tool") {
      toolCalls += 1;
      const state = part.state || {};
      latestTool = {
        name: String(part.tool || "tool"),
        status: String(state.status || "pending").toLowerCase(),
        description: String(state.metadata?.description || state.input?.description || "").trim(),
      };
    }
  }

  return { outputChars, reasoningChars, toolCalls, latestTool, latestPreview, latestPreviewType };
}

function summarizedValue(value) {
  if (value === undefined) return null;
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return { length: text.length, tail: text.slice(-512) };
}

function finishReason(message) {
  return String(message?.info?.finish || "").trim().toLowerCase();
}

function hasStepFinish(message) {
  return messageParts(message).some((part) => String(part?.type || "").toLowerCase() === "step-finish");
}

function terminalMessage(message) {
  return Boolean(message && hasStepFinish(message) && !TERMINAL_FINISH_EXCLUSIONS.has(finishReason(message)));
}

function messageActivitySignature(message) {
  if (!message) return "";
  const meaningfulParts = [];
  for (const part of messageParts(message)) {
    const type = String(part?.type || "").toLowerCase();
    if ((type === "text" || type === "reasoning") && typeof part.text === "string" && part.text.trim()) {
      meaningfulParts.push({ type, text: summarizedValue(part.text) });
      continue;
    }
    if (type === "tool") {
      const state = part.state || {};
      meaningfulParts.push({
        type,
        id: part.callID || part.callId || part.id || "",
        tool: part.tool || "tool",
        status: String(state.status || "pending").toLowerCase(),
        input: summarizedValue(state.input),
        output: summarizedValue(state.output ?? state.metadata?.output),
        error: summarizedValue(state.error),
      });
      continue;
    }
    if (type === "step-finish") meaningfulParts.push({ type, finish: finishReason(message) });
  }
  if (!meaningfulParts.length) return "";
  return JSON.stringify({
    id: message.info?.id || message.id || "",
    finish: finishReason(message),
    parts: meaningfulParts,
  });
}

function todosActive(payload) {
  let active = false;
  walk(payload, (node) => {
    const state = String(node.status || node.state || "").trim().toLowerCase();
    if (ACTIVE_TODO_STATES.has(state)) active = true;
  });
  return active;
}

function childSessionIds(payload) {
  const ids = new Set();
  const values = Array.isArray(payload) ? payload : [];
  for (const item of values) {
    const id = item?.id || item?.sessionID || item?.sessionId;
    if (id) ids.add(String(id));
  }
  return ids;
}

async function appendJsonl(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

function parseSseBlock(block) {
  const dataLines = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (!dataLines.length) return null;
  const text = dataLines.join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return { event: "sse.raw", data: text };
  }
}

function sseMatchesTask(payload, activeSessionIds, projectDir) {
  const ids = collectSessionIds(payload);
  if (ids.size) return [...ids].some((id) => activeSessionIds.has(id));
  const directories = collectDirectories(payload);
  if (!directories.size) return false;
  const expected = path.resolve(projectDir);
  return [...directories].some((directory) => {
    if (process.platform === "win32") return directory.toLowerCase() === expected.toLowerCase();
    return directory === expected;
  });
}

function startSseCapture({
  baseUrl,
  projectDir,
  activeSessionIds,
  idleSessions,
  eventsPath,
  onProgress,
  onInteraction,
  onSessionError,
  onQuotaExceeded,
}) {
  let stopped = false;
  let currentController = null;

  const promise = (async () => {
    const endpoints = ["/global/event", "/event"];
    while (!stopped) {
      let connected = false;
      for (const endpoint of endpoints) {
        if (stopped) break;
        currentController = new AbortController();
        try {
          const url = new URL(`${baseUrl}${endpoint}`);
          url.searchParams.set("directory", projectDir);
          const response = await fetch(url, {
            headers: { "x-opencode-directory": projectDir },
            signal: currentController.signal,
          });
          if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
          connected = true;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (!stopped) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() || "";
            for (const block of blocks) {
              const payload = parseSseBlock(block);
              if (!payload || !sseMatchesTask(payload, activeSessionIds, projectDir)) continue;
              const type = eventType(payload);
              const ids = collectSessionIds(payload);
              if (type === "session.idle") {
                for (const id of ids) idleSessions.add(id);
              } else if (type === "session.status") {
                const data = eventData(payload);
                const statusValue = data?.properties?.status || data?.properties?.state || "";
                const status = String(statusValue?.type || statusValue).toLowerCase();
                if (status === "idle") {
                  for (const id of ids) idleSessions.add(id);
                } else if (status === "retry") {
                  const message = String(statusValue?.message || "");
                  if (isQuotaExceededMessage(message)) {
                    onQuotaExceeded?.(message, isHardQuotaCap(message));
                  }
                }
              }
              if (type === "session.error") onSessionError?.(sessionError(payload));
              if (type === "question.asked" || type === "permission.asked") onInteraction?.();
              await appendJsonl(eventsPath, { timestamp: new Date().toISOString(), payload });
              onProgress?.("sse", { type });
            }
          }
        } catch (error) {
          if (!stopped && error?.name !== "AbortError") {
            await appendJsonl(eventsPath, {
              timestamp: new Date().toISOString(),
              event: "sse.error",
              error: error.message,
              endpoint,
            });
          }
        }
        if (connected) break;
      }
      if (!stopped) await delay(1000);
    }
  })();

  return {
    promise,
    stop() {
      stopped = true;
      currentController?.abort();
    },
  };
}

async function abortAll(client, sessionId, childIds, projectDir) {
  await Promise.allSettled(
    [sessionId, ...childIds].map((id) => client.abortSession(id, projectDir)),
  );
}

function interruptionError(signal) {
  const reason = signal?.reason;
  const error = reason instanceof Error
    ? reason
    : new Error(String(reason || "Autorun 执行被中断"));
  error.code ||= "AUTORUN_INTERRUPTED";
  return error;
}

function throwIfInterrupted(signal) {
  if (signal?.aborted) throw interruptionError(signal);
}

function waitWithInterruption(promise, signal) {
  if (!signal) return promise;
  throwIfInterrupted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(interruptionError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

export async function runMonitoredSession({
  client,
  sessionId,
  projectDir,
  payload,
  eventsPath,
  pollingPath,
  idleTimeoutSec = 600,
  maxRuntimeSec = 6000,
  signal,
  onProgress,
  onQuotaExceeded,
}) {
  const activeSessionIds = new Set([sessionId]);
  const idleSessions = new Set();
  const repliedQuestions = new Set();
  const repliedPermissions = new Set();
  const children = new Set();
  const tokenUsageTracker = new TokenUsageTracker();
  const compileUsageTracker = new CompileUsageTracker();
  const childActivitySignatures = new Map();
  let lastActivityAt = Date.now();
  let lastMessagePollAt = 0;
  let lastChildrenPollAt = 0;
  let lastTodoPollAt = 0;
  let lastInteractionPollAt = 0;
  let messagePollMs = 2000;
  let unchangedMessageCount = 0;
  let lastMessageActivitySignature = "";
  let lastMeaningfulProgress = null;
  let stableTerminalCount = 0;
  let latestMessage = null;
  let latestTodoActive = false;
  let childActive = false;
  let interactionRequested = true;
  let fatalSessionError = null;
  let quotaLimited = false;
  let basicTestsReplyInjected = false;
  const startedAt = Date.now();
  const onActivity = () => { lastActivityAt = Date.now(); };
  const sse = startSseCapture({
    baseUrl: client.baseUrl,
    projectDir,
    activeSessionIds,
    idleSessions,
    eventsPath,
    onProgress,
    onInteraction: () => { interactionRequested = true; },
    onSessionError: (error) => { fatalSessionError ||= error; },
    onQuotaExceeded: (message, hard) => {
      quotaLimited = true;
      onQuotaExceeded?.(message, hard);
      // 硬上限（每周/每月用量上限）重置前不会恢复，直接终止会话，
      // 不再陪 server 无限重试到 idle 超时。主循环会在下一次检查时抛出。
      if (hard) {
        const error = new Error(`API 用量上限，提前停止 Agent：${message}`);
        error.code = "AGENT_QUOTA_EXCEEDED";
        fatalSessionError ||= error;
      }
    },
  });

  try {
    throwIfInterrupted(signal);
    await delay(300);
    throwIfInterrupted(signal);
    await waitWithInterruption(client.promptAsync(sessionId, payload, projectDir, 300), signal);
    if (fatalSessionError) throw fatalSessionError;
    onProgress?.("prompt_submitted", { sessionId });

    while (true) {
      throwIfInterrupted(signal);
      if (fatalSessionError) throw fatalSessionError;
      const now = Date.now();
      if (now - startedAt >= maxRuntimeSec * 1000) {
        throw new Error(`Agent 总运行时间超过 ${maxRuntimeSec} 秒`);
      }
      if (now - lastActivityAt >= idleTimeoutSec * 1000) {
        throw new Error(`Agent 连续 ${idleTimeoutSec} 秒无活动`);
      }

      if (now - lastMessagePollAt >= messagePollMs) {
        lastMessagePollAt = now;
        try {
          const raw = await client.listMessages(sessionId, 1);
          latestMessage = latestAssistantMessage(raw) || latestMessage;
          const tokenUsageChanged = tokenUsageTracker.update(sessionId, latestMessage);
          const compileUsageChanged = compileUsageTracker.update(sessionId, latestMessage);
          if (tokenUsageChanged || compileUsageChanged) onActivity();
          const progress = messageProgress(latestMessage);
          const signature = messageActivitySignature(latestMessage);
          const changed = Boolean(signature && signature !== lastMessageActivitySignature);
          if (changed) {
            lastMessageActivitySignature = signature;
            lastMeaningfulProgress = progress;
            unchangedMessageCount = 0;
            messagePollMs = 2000;
            stableTerminalCount = terminalMessage(latestMessage) ? 1 : 0;
            onActivity();
          } else if (latestMessage) {
            unchangedMessageCount += 1;
            if (unchangedMessageCount >= 3) messagePollMs = 10000;
            if (signature && terminalMessage(latestMessage)) stableTerminalCount += 1;
          }
          await appendJsonl(pollingPath, {
            timestamp: new Date().toISOString(),
            kind: "message",
            sessionId,
            changed,
            data: raw,
          });
          onProgress?.("message", {
            changed,
            finish: finishReason(latestMessage),
            hasMeaningfulOutput: Boolean(lastMeaningfulProgress),
            tokenUsage: tokenUsageTracker.total(),
            compileUsage: compileUsageTracker.summary(),
            ...(signature ? progress : lastMeaningfulProgress || progress),
          });
        } catch (error) {
          await appendJsonl(pollingPath, {
            timestamp: new Date().toISOString(),
            kind: "message_error",
            sessionId,
            error: error.message,
          });
        }
      }

      if (now - lastChildrenPollAt >= 10000) {
        lastChildrenPollAt = now;
        childActive = false;
        try {
          const rawChildren = await client.listChildren(sessionId, projectDir);
          const discovered = childSessionIds(rawChildren);
          for (const childId of discovered) {
            children.add(childId);
            activeSessionIds.add(childId);
            try {
              const childMessages = await client.listMessages(childId, 1);
              const childMessage = latestAssistantMessage(childMessages);
              const tokenUsageChanged = tokenUsageTracker.update(childId, childMessage);
              const compileUsageChanged = compileUsageTracker.update(childId, childMessage);
              if (tokenUsageChanged || compileUsageChanged) {
                onActivity();
                onProgress?.("token_usage", {
                  tokenUsage: tokenUsageTracker.total(),
                  compileUsage: compileUsageTracker.summary(),
                });
              }
              const childSignature = messageActivitySignature(childMessage);
              if (childSignature && childSignature !== childActivitySignatures.get(childId)) {
                childActivitySignatures.set(childId, childSignature);
                onActivity();
              }
              if (!idleSessions.has(childId) && !terminalMessage(childMessage)) childActive = true;
            } catch {
              childActive = true;
            }
          }
          await appendJsonl(pollingPath, {
            timestamp: new Date().toISOString(),
            kind: "children",
            sessionId,
            data: rawChildren,
          });
        } catch {
          // children 查询失败不影响主 message 轮询。
        }
      }

      if (now - lastTodoPollAt >= 60000 || lastTodoPollAt === 0) {
        lastTodoPollAt = now;
        latestTodoActive = false;
        for (const targetId of [sessionId, ...children]) {
          try {
            const todos = await client.listTodos(targetId);
            if (todosActive(todos)) latestTodoActive = true;
            await appendJsonl(pollingPath, {
              timestamp: new Date().toISOString(),
              kind: "todo",
              sessionId: targetId,
              data: todos,
            });
          } catch {
            // TODO 不是唯一终态依据。
          }
        }
      }

      if (interactionRequested || now - lastInteractionPollAt >= 2000) {
        interactionRequested = false;
        lastInteractionPollAt = now;
        await handlePendingInteractions({
          client,
          projectDir,
          repliedQuestions,
          repliedPermissions,
          onActivity,
          onProgress,
        });
      }

      const complete = terminalMessage(latestMessage)
        && !latestTodoActive
        && !childActive
        && (idleSessions.has(sessionId) || stableTerminalCount >= 2);
      if (latestMessage && hasStepFinish(latestMessage)
        && finishReason(latestMessage) === "unknown" && idleSessions.has(sessionId)) {
        throw new Error("OpenCode session 已 idle，但模型 finish reason 为 unknown");
      }
      if (complete) {
        const finalInteractions = await handlePendingInteractions({
          client,
          projectDir,
          repliedQuestions,
          repliedPermissions,
          onActivity,
          onProgress,
        });
        if (finalInteractions.pending || finalInteractions.errors.length) {
          await delay(500);
          continue;
        }
        if (!basicTestsReplyInjected && requestsBasicTestsReply(latestMessage)) {
          await waitWithInterruption(
            client.promptAsync(
              sessionId,
              followUpPayload(payload, BASIC_TESTS_REPLY),
              projectDir,
              300,
            ),
            signal,
          );
          basicTestsReplyInjected = true;
          idleSessions.delete(sessionId);
          latestMessage = null;
          stableTerminalCount = 0;
          unchangedMessageCount = 0;
          messagePollMs = 2000;
          lastMessagePollAt = 0;
          onActivity();
          await appendJsonl(pollingPath, {
            timestamp: new Date().toISOString(),
            kind: "automatic_text_reply",
            sessionId,
            text: BASIC_TESTS_REPLY,
          });
          onProgress?.("text_replied", {
            sessionId,
            text: BASIC_TESTS_REPLY,
            reason: "multimodal_unavailable",
          });
          continue;
        }
        return {
          status: "completed",
          sessionId,
          childSessionIds: [...children],
          finishReason: finishReason(latestMessage),
          output: extractText(latestMessage),
          message: latestMessage,
          tokenUsage: tokenUsageTracker.total(),
          compileUsage: compileUsageTracker.summary(),
          elapsedSec: Math.round((Date.now() - startedAt) / 1000),
          quotaLimited,
        };
      }
      await delay(500);
    }
  } catch (error) {
    await abortAll(client, sessionId, children, projectDir);
    error.sessionId = sessionId;
    error.childSessionIds = [...children];
    error.lastMessage = latestMessage;
    error.tokenUsage = tokenUsageTracker.total();
    error.quotaLimited = quotaLimited;
    throw error;
  } finally {
    sse.stop();
    await Promise.race([sse.promise, delay(2000)]);
  }
}

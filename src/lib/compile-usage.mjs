function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function normalizeStatus(value) {
  return String(value || "unknown").trim().toLowerCase();
}

function hasInterruptedMarker(value) {
  return /\b(?:abort(?:ed)?|cancel(?:led)?|interrupt(?:ed)?)\b|已中断|已取消|工具执行已中止/i.test(text(value));
}

function getCommand(part) {
  return text(part?.state?.input?.command).trim();
}

function getTasks(command) {
  return [...command.matchAll(/\b(?:assemble(?:hap|har|hsp|app)|build(?:hap|har|hsp|app)?|packageapp|signapp)\b/ig)]
    .map((match) => match[0]);
}

// 只统计真正触发 HarmonyOS 构建的 devecocli/hvigor 调用；Web 工程的
// npm/pnpm/yarn build、tasks、clean 和目录探查都不算鸿蒙编译尝试。
function isHarmonyBuildCommand(command) {
  const devecoBuild = /\bdevecocli(?:\.(?:bat|cmd|js))?\s+build\b(?!\s+clean\b)/i.test(command);
  const hvigorBuild = /\bhvigorw(?:\.(?:bat|cmd|js))?\b/i.test(command)
    && getTasks(command).length > 0;
  return devecoBuild || hvigorBuild;
}

function classifyAttempt(state) {
  const status = normalizeStatus(state?.status);
  const metadata = state?.metadata || {};
  const output = `${text(state?.output)}\n${text(metadata.output)}\n${text(state?.error)}`;
  const exitCode = Number.isFinite(Number(metadata.exit)) ? Number(metadata.exit) : null;
  const interrupted = Boolean(metadata.interrupted) || hasInterruptedMarker(state?.error) || hasInterruptedMarker(metadata.error);

  if (interrupted || ["aborted", "cancelled", "canceled", "interrupted"].includes(status)) return "interrupted";
  if (status === "running" || status === "pending" || status === "unknown") return "running";
  if (exitCode !== null) return exitCode === 0 ? "succeeded" : "failed";
  if (status === "error" || status === "failed") return "failed";
  if (/\bBUILD FAILED\b|\bFAILED\s+in\b/i.test(output)) return "failed";
  return "succeeded";
}

function durationMs(state) {
  const start = Number(state?.time?.start);
  const end = Number(state?.time?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round(end - start);
}

function attemptKey(sessionId, part, messageIndex, partIndex) {
  return String(part?.callID || part?.callId || part?.id || `${sessionId}:message-${messageIndex}:part-${partIndex}`);
}

export function emptyCompileUsage() {
  return {
    attempts: 0,
    succeeded: 0,
    failed: 0,
    interrupted: 0,
    running: 0,
  };
}

export function addCompileUsage(...values) {
  const total = emptyCompileUsage();
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    for (const field of Object.keys(total)) total[field] += numeric(value[field]);
  }
  return total;
}

export function collectCompileAttempts(sessions) {
  const seen = new Set();
  const items = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const sessionId = String(session?.sessionId || "");
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const parts = Array.isArray(messages[messageIndex]?.parts) ? messages[messageIndex].parts : [];
      for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        const part = parts[partIndex];
        if (String(part?.type || "").toLowerCase() !== "tool" || String(part?.tool || "").toLowerCase() !== "bash") continue;
        const command = getCommand(part);
        if (!isHarmonyBuildCommand(command)) continue;
        const key = `${sessionId}:${attemptKey(sessionId, part, messageIndex, partIndex)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const state = part.state || {};
        const metadata = state.metadata || {};
        const outcome = classifyAttempt(state);
        items.push({
          callId: String(part.callID || part.callId || part.id || ""),
          sessionId,
          command,
          tasks: getTasks(command),
          toolStatus: normalizeStatus(state.status),
          outcome,
          startedAt: Number.isFinite(Number(state?.time?.start)) ? new Date(Number(state.time.start)).toISOString() : "",
          finishedAt: Number.isFinite(Number(state?.time?.end)) ? new Date(Number(state.time.end)).toISOString() : "",
          durationMs: durationMs(state),
          exitCode: Number.isFinite(Number(metadata.exit)) ? Number(metadata.exit) : null,
          description: text(state?.input?.description || metadata.description),
        });
      }
    }
  }

  const usage = emptyCompileUsage();
  for (const item of items) {
    usage.attempts += 1;
    usage[item.outcome] += 1;
  }
  return { ...usage, items };
}

export class CompileUsageTracker {
  constructor() {
    this.attempts = new Map();
  }

  update(sessionId, message) {
    const latest = collectCompileAttempts([{ sessionId, messages: [message] }]);
    let changed = false;
    for (const item of latest.items) {
      const key = `${item.sessionId}:${item.callId || item.command}`;
      const serialized = JSON.stringify(item);
      if (this.attempts.get(key)?.serialized === serialized) continue;
      this.attempts.set(key, { item, serialized });
      changed = true;
    }
    return changed;
  }

  summary() {
    const items = [...this.attempts.values()].map((entry) => entry.item);
    const usage = emptyCompileUsage();
    for (const item of items) {
      usage.attempts += 1;
      usage[item.outcome] += 1;
    }
    return usage;
  }
}

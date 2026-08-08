const TOKEN_FIELDS = ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total", "cost"];

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function emptyTokenUsage() {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
  };
}

export function messageTokenUsage(message) {
  const tokens = message?.info?.tokens;
  if (!tokens || typeof tokens !== "object") return null;
  const cache = tokens.cache && typeof tokens.cache === "object" ? tokens.cache : {};
  const usage = {
    input: numeric(tokens.input),
    output: numeric(tokens.output),
    reasoning: numeric(tokens.reasoning),
    cacheRead: numeric(cache.read),
    cacheWrite: numeric(cache.write),
    total: numeric(tokens.total),
    cost: numeric(message?.info?.cost),
  };
  if (!usage.total) {
    usage.total = usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite;
  }
  return usage;
}

export function addTokenUsage(...values) {
  const total = emptyTokenUsage();
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    for (const field of TOKEN_FIELDS) total[field] += numeric(value[field]);
  }
  total.cost = Number(total.cost.toFixed(12));
  return total;
}

export function aggregateSessionMessages(sessions) {
  const latestByMessage = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const sessionId = String(session?.sessionId || "session");
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      const usage = messageTokenUsage(message);
      if (!usage) continue;
      const messageId = String(message?.info?.id || message?.id || `message-${index}`);
      latestByMessage.set(`${sessionId}:${messageId}`, usage);
    }
  }
  return addTokenUsage(...latestByMessage.values());
}

export class TokenUsageTracker {
  constructor() {
    this.messages = new Map();
  }

  update(sessionId, message) {
    const usage = messageTokenUsage(message);
    if (!usage) return false;
    const messageId = String(message?.info?.id || message?.id || "");
    if (!messageId) return false;
    const key = `${sessionId}:${messageId}`;
    const previous = this.messages.get(key);
    const serialized = JSON.stringify(usage);
    if (previous?.serialized === serialized) return false;
    this.messages.set(key, { usage, serialized });
    return true;
  }

  total() {
    return addTokenUsage(...[...this.messages.values()].map((item) => item.usage));
  }
}

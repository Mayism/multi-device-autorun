import { setTimeout as delay } from "node:timers/promises";

function withDirectory(url, directory) {
  if (!directory) return url;
  const target = new URL(url);
  target.searchParams.set("directory", directory);
  return target.toString();
}

function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class OpenCodeHttpError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = "OpenCodeHttpError";
    this.status = status;
    this.body = body;
  }
}

export class OpenCodeClient {
  constructor(baseUrl) {
    this.baseUrl = String(baseUrl || "").replace(/\/$/, "");
  }

  async request(pathname, {
    method = "GET",
    body,
    directory = "",
    timeoutSec = 10,
    raw = false,
    headers = {},
    signal,
  } = {}) {
    const url = withDirectory(`${this.baseUrl}${pathname}`, directory);
    const requestHeaders = { ...headers };
    if (directory) requestHeaders["x-opencode-directory"] = directory;
    let requestBody;
    if (body !== undefined) {
      requestHeaders["Content-Type"] ||= "application/json";
      requestBody = typeof body === "string" ? body : JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: requestBody,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeoutSec) * 1000)])
          : AbortSignal.timeout(Math.max(1, timeoutSec) * 1000),
      });
    } catch (error) {
      throw new OpenCodeHttpError(`${method} ${pathname} 请求失败: ${error.message}`, {
        body: error,
      });
    }

    const text = await response.text();
    if (!response.ok) {
      throw new OpenCodeHttpError(`${method} ${pathname} 返回 HTTP ${response.status}`, {
        status: response.status,
        body: parseBody(text),
      });
    }
    return raw ? text : parseBody(text);
  }

  async health(timeoutSec = 3) {
    try {
      const result = await this.request("/global/health", { timeoutSec });
      return Boolean(result?.healthy ?? true);
    } catch {
      return false;
    }
  }

  async waitUntilHealthy(timeoutSec = 120, intervalMs = 1000) {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      if (await this.health()) return true;
      await delay(intervalMs);
    }
    return false;
  }

  getConfig(timeoutSec = 30, signal, directory = "") {
    return this.request("/config", { timeoutSec, signal, directory });
  }

  getProviders(directory, timeoutSec = 30, signal) {
    return this.request("/config/providers", {
      directory,
      timeoutSec,
      signal,
    });
  }

  async resolveModel(modelId, timeoutSec = 30) {
    const config = await this.getConfig(timeoutSec);
    for (const [providerId, provider] of Object.entries(config?.provider || {})) {
      if (Object.hasOwn(provider?.models || {}, modelId)) {
        return { providerId, modelId };
      }
    }
    throw new Error(`OpenCode Server 配置中未找到模型: ${modelId}`);
  }

  async validateAgent(agentName, timeoutSec = 30) {
    const config = await this.getConfig(timeoutSec);
    if (!Object.hasOwn(config?.agent || {}, agentName)) {
      throw new Error(`OpenCode Server 配置中未找到 Agent: ${agentName}`);
    }
    return true;
  }

  createSession(directory, timeoutSec = 30) {
    return this.request("/session", {
      method: "POST",
      body: {},
      directory,
      timeoutSec,
    });
  }

  promptAsync(sessionId, payload, directory, timeoutSec = 300) {
    return this.request(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      method: "POST",
      body: payload,
      directory,
      timeoutSec,
    });
  }

  sendMessageText(sessionId, payload, directory, timeoutSec = 120) {
    return this.request(`/session/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      body: payload,
      directory,
      timeoutSec,
      raw: true,
    });
  }

  listMessages(sessionId, limit = 1, timeoutSec = 10) {
    const suffix = limit ? `?limit=${encodeURIComponent(limit)}` : "";
    return this.request(`/session/${encodeURIComponent(sessionId)}/message${suffix}`, { timeoutSec });
  }

  listChildren(sessionId, directory, timeoutSec = 10) {
    return this.request(`/session/${encodeURIComponent(sessionId)}/children`, {
      directory,
      timeoutSec,
    });
  }

  listTodos(sessionId, timeoutSec = 10) {
    return this.request(`/session/${encodeURIComponent(sessionId)}/todo`, { timeoutSec });
  }

  listSkills(directory, timeoutSec = 30, signal) {
    return this.request("/skill", { directory, timeoutSec, signal });
  }

  listQuestions(directory, timeoutSec = 10) {
    return this.request("/question", { directory, timeoutSec });
  }

  listPermissions(directory, timeoutSec = 10) {
    return this.request("/permission", { directory, timeoutSec });
  }

  replyQuestion(requestId, answers, directory, timeoutSec = 30) {
    return this.request(`/question/${encodeURIComponent(requestId)}/reply`, {
      method: "POST",
      body: { answers },
      directory,
      timeoutSec,
    });
  }

  replyPermission(requestId, directory, reply = "once", timeoutSec = 30) {
    return this.request(`/permission/${encodeURIComponent(requestId)}/reply`, {
      method: "POST",
      body: { reply },
      directory,
      timeoutSec,
    });
  }

  abortSession(sessionId, directory, timeoutSec = 10) {
    return this.request(`/session/${encodeURIComponent(sessionId)}/abort`, {
      method: "POST",
      directory,
      timeoutSec,
    });
  }
}

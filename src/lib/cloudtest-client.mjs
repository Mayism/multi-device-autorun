// cloudtest-client.mjs
// AGC 云测试（AppTesting）HTTP 客户端。
// 接口与参数取自 developer.huawei.com 云测试控制台抓包（HAR），调用序列：
//   refresh（换取新 auth+csrfToken）→ nsp/upload → OBS PUT → app/down/analyze
//   → app/analyze/{objectId}(轮询至 finishAnalyze) → app/list(查询历史包)
//   → business/device/list(真机列表) → quota/predictConfirm → task/submit(逐台尝试)
//   → task/taskgroups(轮询任务组状态)
//
// OBS 上传代理：配置 cloudTest.proxy（http://user:pass@host:port）时走认证代理
// （HTTPS 经 CONNECT 隧道），未配置则直连；obs 签名头在 putObject 原样透传。

//   每次运行先调 GET edge/oauth2/v1/refresh（GET+JSON body，显式 Content-Length，
//   cookie 为 agc_authInfo URL 编码单对）——新 authInfo 在响应 Set-Cookie 的
//   agc_authInfo 项中，csrfToken 在响应 body 中；之后所有接口只带四个鉴权头：
//   Cookie（agc_authInfo 单对）、agcCsrfToken、agcTeamId、productId。
//   token 轮换后旧值作废，401 时自动再 refresh 重试。

import https from "node:https";
import http from "node:http";
import tls from "node:tls";

const DEFAULT_BASE_URL = "https://agc-drcn.developer.huawei.com/agc/edge/cloudTest/2/apptest/task";
// 报告接口在 apptest/report 前缀下（与任务接口的 apptest/task 前缀不同）
const REPORT_BASE_URL = "https://agc-drcn.developer.huawei.com/agc/edge/cloudTest/2/apptest/report";
const REFRESH_URL = "https://agc-drcn.developer.huawei.com/agc/edge/oauth2/v1/refresh";

// taskgroups 列表查询参数与控制台抓包保持一致（刚提交的 status=1/resultStatus=0
// 任务也会出现在该过滤条件下，已验证）。
const TASKGROUP_QUERY = {
  name: "",
  currentPage: "1",
  pageSize: "50",
  createTypes: "51,68,70,55,56,72,18",
  taskGroupStatus: "1,2,3,4,5,6",
  resultStatus: "1,2",
  taskType: "1,2,3,6,27,28,14,18",
  appTypes: "1,10,11,5,6,7,8,33",
};

/** 从任意粘贴形态提取 authInfo 的纯 JSON 字符串。
 * 支持：整行 cookie 头（取 agc_authInfo/authInfo 对）、单对键值、裸值；
 * 值可为 URL 编码、引号转义或原始 JSON。 */
export function extractTokenJson(value) {
  const trimmed = String(value || "").trim().replace(/[\r\n]+/g, "");
  if (!trimmed) throw new Error("cookie 为空");
  const candidates = [];
  if (trimmed.includes(";")) {
    const jar = new Map();
    for (const pair of trimmed.split(";")) {
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    candidates.push(jar.get("agc_authInfo"), jar.get("authInfo"));
  } else if (/^agc_authInfo=/.test(trimmed)) {
    candidates.push(trimmed.slice("agc_authInfo=".length));
  } else {
    candidates.push(trimmed);
  }
  for (let candidate of candidates) {
    if (!candidate) continue;
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      // 非 URL 编码形式，继续
    }
    if (candidate.startsWith('"') && candidate.endsWith('"')) {
      candidate = candidate.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && (parsed.accesstoken || parsed.accessToken)) {
        return candidate;
      }
    } catch {
      // 尝试下一个候选
    }
  }
  throw new Error("无法从 cookie 中解析出 authInfo token JSON（应包含 accesstoken 字段）");
}

function toAuthCookie(tokenJson) {
  // URL 编码形式（实测 refresh 与主接口均接受；引号转义形式会被判 refreshToken 失效）
  return `agc_authInfo=${encodeURIComponent(String(tokenJson))}`;
}

function parseCookiePairs(header) {
  const jar = new Map();
  for (const pair of String(header || "").split(";")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    jar.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return jar;
}

/** 规范化粘贴内容为整行 cookie：整行原样（补派生 agc_authInfo），
 * 单对/裸值包装为 agc_authInfo 对（裸 JSON 自动 URL 编码）。 */
function normalizeCookieLine(value) {
  const trimmed = String(value || "").trim().replace(/[\r\n]+/g, "");
  if (!trimmed) return "";
  const pairs = new Map();
  if (trimmed.includes(";")) {
    for (const [key, pairValue] of parseCookiePairs(trimmed)) pairs.set(key, pairValue);
  } else if (/^agc_authInfo=/.test(trimmed)) {
    pairs.set("agc_authInfo", trimmed.slice("agc_authInfo=".length));
  } else {
    return toAuthCookie(extractTokenJson(trimmed));
  }
  // 主域 cookie 中只有 authInfo（引号转义 JSON）时派生 agc_authInfo
  if (!pairs.has("agc_authInfo") && pairs.has("authInfo")) {
    const raw = pairs.get("authInfo");
    try {
      const plain = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1).replace(/\\"/g, '"') : raw;
      JSON.parse(plain);
      pairs.set("agc_authInfo", encodeURIComponent(plain));
    } catch {
      // authInfo 非 JSON，保留原样
    }
  }
  return [...pairs].map(([key, pairValue]) => `${key}=${pairValue}`).join("; ");
}

/** 解析代理地址：支持 http://user:pass@host:port 或 host:port，返回 URL 或 null。 */
function parseProxyUrl(proxy) {
  const raw = String(proxy || "").trim();
  if (!raw) return null;
  try {
    return new URL(/^https?:\/\//.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
}

/** 代理 Basic 认证头（URL 中的 user:pass，特殊字符需在配置里 URL 编码）。 */
function proxyAuthorization(proxyUrl) {
  if (!proxyUrl?.username && !proxyUrl?.password) return "";
  const user = decodeURIComponent(proxyUrl.username || "");
  const password = decodeURIComponent(proxyUrl.password || "");
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

/**
 * 统一 HTTP 传输：node:http(s) 直连或经 HTTP 代理（https 走 CONNECT 隧道）。
 * Node 的 fetch/https.request 默认不读 HTTP_PROXY 环境变量，代理需在此显式支持。
 * @returns {Promise<{status: number, text: string, setCookies: string[]}>}
 */
export function sendRequest({ url, method, headers = {}, body, timeoutMs = 30_000, proxy = "", tlsOptions = {} }) {
  return new Promise((resolve, reject) => {
    const target = url instanceof URL ? url : new URL(url);
    const isTls = target.protocol === "https:";
    const transport = isTls ? https : http;
    const bodyBuffer = body === undefined || body === null
      ? null
      : Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
    const finalHeaders = { ...headers };
    if (bodyBuffer !== null) {
      finalHeaders["Content-Length"] ??= String(bodyBuffer.length);
    }
    const baseOptions = {
      hostname: target.hostname,
      port: target.port || (isTls ? 443 : 80),
      method,
      path: `${target.pathname}${target.search}`,
      headers: finalHeaders,
    };
    let settled = false;
    let timer = null;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const registerError = fail;
    const issue = (options, customTransport) => {
      const req = (customTransport || transport).request(options, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => succeed({
          status: res.statusCode,
          text: Buffer.concat(chunks).toString("utf8"),
          setCookies: res.headers["set-cookie"] || [],
        }));
        res.on("error", registerError);
      });
      req.once("error", registerError);
      if (bodyBuffer !== null) req.write(bodyBuffer);
      req.end();
      return req;
    };
    timer = setTimeout(() => {
      fail(new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）: ${method} ${target.hostname}`));
    }, timeoutMs);
    timer.unref?.();

    const proxyUrl = parseProxyUrl(proxy);
    if (!proxyUrl) {
      issue({ ...baseOptions, ...tlsOptions });
      return;
    }

    if (!isTls) {
      // http 目标：直接向代理发起，使用绝对 URL
      const proxyAuth = proxyAuthorization(proxyUrl);
      issue({
        ...baseOptions,
        hostname: proxyUrl.hostname,
        port: proxyUrl.port || 80,
        path: target.href,
        headers: {
          ...finalHeaders,
          Host: target.host,
          ...(proxyAuth ? { "Proxy-Authorization": proxyAuth } : {}),
        },
      });
      return;
    }
    // https 目标：先向代理建立 CONNECT 隧道，再在隧道上做 TLS 与请求
    const proxyAuth = proxyAuthorization(proxyUrl);
    const connectReq = http.request({
      hostname: proxyUrl.hostname,
      port: proxyUrl.port || 80,
      method: "CONNECT",
      path: `${target.hostname}:${baseOptions.port}`,
      headers: {
        Host: `${target.hostname}:${baseOptions.port}`,
        ...(proxyAuth ? { "Proxy-Authorization": proxyAuth } : {}),
      },
      timeout: timeoutMs,
    });
    connectReq.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`代理 CONNECT 失败: HTTP ${res.statusCode}（${proxyUrl.host}）`));
        return;
      }
      // 默认严格校验证书；tlsOptions 可传企业 CA（ca）或在受信内网场景跳过校验（rejectUnauthorized:false）。
      // TLS 在隧道上由我们建立，之后的请求用 http.request 在已加密 socket 上收发
      //（不能再交给 https.request——它会对 TLS socket 重复握手）。
      const tlsSocket = tls.connect({ socket, servername: target.hostname, ...tlsOptions }, () => {
        issue({ ...baseOptions, createConnection: () => tlsSocket }, http);
      });
      tlsSocket.once("error", fail);
    });
    connectReq.once("error", fail);
    connectReq.once("timeout", () => {
      connectReq.destroy(new Error(`代理连接超时: ${proxyUrl.host}`));
    });
    connectReq.end();
  });
}


export class CloudTestClient {
  constructor({ teamId, projectId, agcAuthInfo, baseUrl = DEFAULT_BASE_URL, proxy = "" } = {}) {
    if (!teamId) throw new Error("缺少 cloudTest.teamId");
    if (!projectId) throw new Error("缺少 cloudTest.projectId");
    if (!agcAuthInfo) throw new Error("缺少 cloudTest.agcAuthInfo（agc_authInfo 值或整行 cookie）");
    this.teamId = String(teamId);
    this.projectId = String(projectId);
    // 整行 cookie jar：cloudTest 接口需完整浏览器 cookie（含 HWWAFSESID 等 WAF 会话）；
    // 仅粘 token 单值时自动包装为 agc_authInfo 对（但主接口会因缺 WAF 会话被拒）
    this.cookieJar = parseCookiePairs(normalizeCookieLine(agcAuthInfo));
    this.csrfToken = String(this.cookieJar.get("csrfToken") || "");
    this.tokenJson = extractTokenJson(agcAuthInfo);
    this.baseUrl = baseUrl.replace(/\/$/, "");
    // 代理仅用于 OBS 直传（云测试 API 与 refresh 始终直连）
    this.proxy = String(proxy || "").trim();
    this.refreshing = null;
  }

  cookieHeader() {
    return [...this.cookieJar].map(([key, value]) => `${key}=${value}`).join("; ");
  }

  /** token 过期时间（毫秒时间戳），解析失败返回 0。
   * 兼容浏览器会话格式（expiretime 为 "20260818T042046Z"）与
   * refresh 生成格式（createtime 毫秒时间戳 + expiretime 秒数时长）。 */
  authExpireTimeMs() {
    try {
      const info = JSON.parse(this.tokenJson);
      const rawExpire = String(info.expiretime || info.expiresTime || "");
      const ts = rawExpire.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
      if (ts) {
        const expire = Date.parse(`${ts[1]}-${ts[2]}-${ts[3]}T${ts[4]}:${ts[5]}:${ts[6]}Z`);
        if (Number.isFinite(expire)) return expire;
      }
      const created = Number(info.createtime);
      const durationSec = Number(info.expiretime);
      if (Number.isFinite(created) && created > 1e12 && Number.isFinite(durationSec) && durationSec > 0 && durationSec < 1e6) {
        return created + durationSec * 1000;
      }
    } catch {
      // token 非法时交由请求阶段报错
    }
    return 0;
  }

  authCookie() {
    return toAuthCookie(this.tokenJson);
  }

  baseHeaders(json = false) {
    // 四个鉴权头（与控制台 py 脚本一致）：agc_authInfo 单对 + agcCsrfToken + agcTeamId + productId
    const headers = {
      Accept: "application/json, text/plain, */*",
      Cookie: this.authCookie(),
      agcTeamId: this.teamId,
      productId: this.projectId,
      agcCsrfToken: this.csrfToken,
    };
    if (json) headers["Content-Type"] = "application/json";
    return headers;
  }

  /**
   * GET edge/oauth2/v1/refresh 轮换登录态：换取新 authInfo 与 csrfToken。
   * 请求：GET + JSON body {"agcTeamId":...}，Cookie 为 agc_authInfo 单对（引号转义 JSON）。
   * 响应形态未知，容错解析 data / data.authInfo / data.csrfToken 等常见位置。
   */
  async refreshAuth({ timeoutMs = 30_000 } = {}) {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      // GET + JSON body（sendRequest 会显式设置 Content-Length：
      // 缺省时 node 用 chunked 传输，网关对 GET+chunked 直接 502）
      const res = await sendRequest({
        url: REFRESH_URL,
        method: "GET",
        headers: {
          Cookie: this.authCookie(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ agcTeamId: this.teamId }),
        timeoutMs,
      });
      const text = String(res.text || "");
      if ((Number(res.status) || 0) >= 400) {
        const detail = /get refreshToken failed/i.test(text)
          ? "refreshToken 已失效（可能已被其它端使用），请更新 config/agc-cookie.txt"
          : text.slice(0, 200);
        throw new Error(`刷新登录态失败: HTTP ${res.status}: ${detail}`);
      }
      const payload = await Promise.resolve(text ? JSON.parse(text) : {}).catch(() => ({}));
      const data = payload?.data ?? payload;
      // 新 authInfo 在响应 Set-Cookie 头的 agc_authInfo 项中（与控制台 py 脚本一致）
      const setCookieAuth = (res.setCookies || [])
        .map((raw) => String(raw))
        .find((raw) => /^agc_authInfo=/.test(raw));
      if (setCookieAuth) {
        const value = setCookieAuth.slice("agc_authInfo=".length).split(";")[0];
        this.tokenJson = extractTokenJson(decodeURIComponent(value));
      }
      const newCsrf = data?.csrfToken || data?.csrftoken || payload?.csrfToken;
      if (newCsrf) this.csrfToken = String(newCsrf);
      return { tokenJson: this.tokenJson, csrfToken: this.csrfToken, payload };
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  /** 每次运行先刷新一次登录态（本方案要求 refresh 成功获取 auth+csrfToken）。 */
  async bootstrapAuth() {
    await this.refreshAuth();
    const expire = this.authExpireTimeMs();
    return expire ? new Date(expire).toISOString() : "";
  }

  async request(method, pathname, { query, body, timeoutMs = 30_000, retries = 2, root = "task" } = {}) {
    const base = root === "report" ? REPORT_BASE_URL : this.baseUrl;
    const target = new URL(`${base}/${pathname.replace(/^\//, "")}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (Array.isArray(value)) {
          for (const item of value) target.searchParams.append(key, String(item));
        } else if (value !== undefined && value !== null) {
          target.searchParams.append(key, String(value));
        }
      }
    }
    let lastError = null;
    let refreshed = false;
    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      let res;
      try {
        res = await fetch(target, {
          method,
          headers: this.baseHeaders(body !== undefined),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        lastError = error;
        if (attempt > retries) break;
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if ((res.status === 401 || res.status === 403) && !refreshed) {
          // token 被轮换/过期：refresh 换新 auth+csrfToken 后重试一次
          refreshed = true;
          try {
            await this.refreshAuth();
            lastError = new Error(`HTTP ${res.status}（已 refresh 轮换登录态重试）`);
            continue;
          } catch (refreshError) {
            throw new Error(`HTTP ${res.status}，且 refresh 轮换失败: ${refreshError.message}`);
          }
        }
        if (res.status === 401 || res.status === 403) {
          const hint = /csrf/i.test(text)
            ? "csrfToken 校验失败"
            : "登录态失效且 refresh 轮换失败：请更新 config/agc-cookie.txt 中的 token";
          throw new Error(`HTTP ${res.status}（${hint}）: ${text.slice(0, 200)}`);
        }
        lastError = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        if (attempt > retries) break;
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      const rawText = await res.text();
      let payload;
      try {
        payload = JSON.parse(rawText);
      } catch {
        lastError = new Error(`响应不是合法 JSON: ${rawText.slice(0, 200)}`);
        break;
      }
      // 两种响应包：{result, errorCode, message, data} 与 {code, msg, data}
      if (payload?.result === false) {
        lastError = new Error(`errorCode=${payload.errorCode} ${payload.message || ""}`.trim());
        break;
      }
      if (payload?.code !== undefined && payload.code !== 200) {
        lastError = new Error(`code=${payload.code} ${payload.msg || ""}`.trim());
        break;
      }
      return payload;
    }
    throw new Error(`${method} ${pathname} 失败: ${lastError?.message || lastError}`);
  }

  /** 查询历史已上传的软件包（第 1/100/1 页与控制台一致）。 */
  async listApps(pageSize = 100) {
    const payload = await this.request("GET", `app/list/1/${pageSize}/1`);
    return Array.isArray(payload?.data?.listResult) ? payload.data.listResult : [];
  }

  /** 申请 OBS 直传凭证；返回的 data 是 JSON 字符串，含 url/headers/objectId。 */
  async requestUploadUrl({ fileName, fileSize, sha256 }) {
    const payload = await this.request("POST", "nsp/upload", {
      body: { fileSize, fileName, sha256 },
    });
    let obs;
    try {
      obs = typeof payload?.data === "string" ? JSON.parse(payload.data) : payload?.data;
    } catch {
      throw new Error(`nsp/upload 返回的 data 无法解析: ${payload?.data}`);
    }
    if (!obs?.url || !obs?.headers) throw new Error(`nsp/upload 返回缺少 url/headers: ${JSON.stringify(obs).slice(0, 300)}`);
    return obs;
  }

  /** 直传 OBS。nsp/upload 返回的 headers 是完整的签名头集合（SignedHeaders 覆盖
   *  host/content-length/content-type/x-amz-*），必须原样透传，剥离任何签名头
   *  都会导致 OBS 端计算的签名不一致（403 SignatureDoesNotMatch）。 */
  async putObject(obs, bytes) {
    const headers = obs.headers || {};
    const forward = {};
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      if (lower === "connection") continue;
      forward[key] = value;
    }
    // OBS 直传可配置代理（cloudTest.proxy），其余 AGC 接口始终直连。
    // 配置了代理时默认跳过证书校验（兼容企业 MITM 代理的自签证书），无需配置项；
    // 直连（真实 OBS 证书）保持默认校验。
    const res = await sendRequest({
      url: obs.url,
      method: obs.method || "PUT",
      headers: forward,
      body: bytes,
      timeoutMs: 300_000,
      proxy: this.proxy,
      tlsOptions: this.proxy ? { rejectUnauthorized: false } : {},
    });
    if ((Number(res.status) || 0) >= 400) {
      throw new Error(`OBS 上传失败: HTTP ${res.status}: ${String(res.text || "").slice(0, 300)}`);
    }
    return true;
  }

  /** 触发云端对已上传包的下载与解析。 */
  async triggerAnalyze(objectId) {
    return this.request("GET", "app/down/analyze", { query: { objectId } });
  }

  async getAnalyzeStatus(objectId) {
    return this.request("GET", `app/analyze/${encodeURIComponent(objectId)}`);
  }

  /** 轮询包解析，直到 finishAnalyze；返回 uploadAppRsp（含 id/appType/geApiLevel 等）。 */
  async pollAnalyze(objectId, { timeoutMs = 600_000, intervalMs = 3_000, onProgress } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastStep = "";
    while (Date.now() < deadline) {
      const payload = await this.getAnalyzeStatus(objectId);
      const data = payload?.data || {};
      const step = String(data.step || "");
      if (step !== lastStep) {
        onProgress?.(`包解析进度: ${step || "<unknown>"}`);
        lastStep = step;
      }
      if (step === "finishAnalyze") {
        if (data.result === false) {
          const detail = data.errorMessageCn || data.errorMessageEn || data.message || "";
          throw new Error(`包解析失败: ${detail}（errorCode=${data.errorCode}）`);
        }
        if (!data.uploadAppRsp?.id) throw new Error(`包解析完成但缺少 uploadAppRsp.id: ${JSON.stringify(data).slice(0, 300)}`);
        return data.uploadAppRsp;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`等待包解析超时（${Math.round(timeoutMs / 1000)} 秒，最后步骤: ${lastStep || "none"}）`);
  }

  /**
   * 可用真机列表（按包解析结果过滤）。
   * appType/apiLevels 来自云端解析结果；testCategories 为逗号分隔的类别数字，
   * 返回 data.deviceList。
   */
  async listBusinessDevices({ appType, testCategories, apiLevels }) {
    const serialize = (value) => {
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return value.map(String).join(",");
      return String(value ?? "");
    };
    const payload = await this.request("GET", "business/device/list", {
      query: {
        appType,
        testCategories: serialize(testCategories),
        apiLevels: serialize(apiLevels),
      },
    });
    return Array.isArray(payload?.data?.deviceList) ? payload.data.deviceList : [];
  }

  /** 提交前的配额预测（非必须，失败不影响提交）。 */
  async predictConfirm(payload) {
    return this.request("POST", "business/quota/predictConfirm", { body: payload });
  }

  /** 提交测试任务，返回任务组 id（字符串）。 */
  async submitTask(payload) {
    const result = await this.request("POST", "task/submit", { body: payload });
    const taskGroupId = result?.data ? String(result.data) : "";
    if (!taskGroupId) throw new Error(`task/submit 未返回任务组 id: ${JSON.stringify(result).slice(0, 300)}`);
    return taskGroupId;
  }

  /** 任务组列表（含执行状态），用于提交后轮询。 */
  async listTaskGroups() {
    const payload = await this.request("GET", "task/taskgroups", { query: TASKGROUP_QUERY });
    return Array.isArray(payload?.data?.listResult) ? payload.data.listResult : [];
  }

  // ---- 报告接口（apptest/report 前缀，用于任务完成后生成 HTML 结果页） ----

  /** 报告页主信息：任务组元数据 + 应用信息（含图标临时 URL）+ 设备列表 + 起止时间。 */
  async getReportApps(taskGroupId) {
    const payload = await this.request("GET", `report/developer/apps/${taskGroupId}`, {
      query: { productId: this.projectId },
    });
    return Array.isArray(payload?.data) ? payload.data : [];
  }

  /** 总览结果：规则通过/失败/警告计数与设备完成度。 */
  async getOverviewResult(taskGroupId) {
    const payload = await this.request("GET", "report/overview/result", {
      root: "report",
      query: { taskGroupId, productId: this.projectId },
    });
    return payload?.data || null;
  }

  /** 问题明细：规则号/描述/规范链接/出错设备与位置。 */
  async getOverviewProblem(taskGroupId, category) {
    const payload = await this.request("GET", "report/overview/problem", {
      root: "report",
      query: { taskGroupId, category, productId: this.projectId },
    });
    return Array.isArray(payload?.data) ? payload.data : [];
  }

  /** 设备×用例明细矩阵：每设备 useCaseResultList（PASS/FAIL/NO_VALUE + ruleNums）。 */
  async getReportTaskList(taskGroupId, category) {
    const payload = await this.request("GET", "report/task/list", {
      root: "report",
      query: { taskGroupId, category, productId: this.projectId },
    });
    return Array.isArray(payload?.data) ? payload.data : [];
  }

  /** 报告表头配置：用例 prop → 中文列名映射与分组。 */
  async getDevReportTitle(taskGroupId, category) {
    const payload = await this.request("GET", `devReportTitle/list/${taskGroupId}/${category}`, {
      root: "report",
      query: { productId: this.projectId },
    });
    return Array.isArray(payload?.data) ? payload.data : [];
  }
}

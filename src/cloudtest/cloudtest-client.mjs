// AGC CloudTest 的编排入口；鉴权、HTTP 调用和 OBS 传输由 Python worker 处理。
import { runPythonWorker, runPythonWorkerSync } from "../runtime/python-worker.mjs";

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

function decode(buffer) {
  return JSON.parse(buffer.toString("utf8"));
}

export function extractTokenJson(value) {
  return decode(runPythonWorkerSync("cloudtest-client-extract-token", { value }));
}

/** 供外部调用的低层 HTTP 入口；云测试主流程通过 CloudTestClient.request 调用。 */
export async function sendRequest({ url, method, headers = {}, body, timeoutMs = 30_000, proxy = "", tlsOptions = {} }) {
  const input = {
    url: String(url), method, headers, timeoutMs, proxy,
    verifyTls: tlsOptions.rejectUnauthorized !== false,
  };
  if (tlsOptions.ca) input.ca = Buffer.isBuffer(tlsOptions.ca) ? tlsOptions.ca.toString("utf8") : String(tlsOptions.ca);
  if (Buffer.isBuffer(body)) input.bodyBase64 = body.toString("base64");
  else if (body !== undefined && body !== null) input.body = String(body);
  return decode(await runPythonWorker("cloudtest-client-send", input));
}

export class CloudTestClient {
  constructor(settings = {}) {
    this._state = decode(runPythonWorkerSync("cloudtest-client-init", settings));
    this.teamId = this._state.teamId;
    this.projectId = this._state.projectId;
    this.baseUrl = this._state.baseUrl;
    this.proxy = this._state.proxy;
    this.cookieJar = new Map(Object.entries(this._state.cookieJar));
    this.tokenJson = this._state.tokenJson;
    this.csrfToken = this._state.csrfToken;
    this.refreshing = null;
    this._queue = Promise.resolve();
  }

  _syncState(state) {
    this._state = state;
    this.tokenJson = state.tokenJson;
    this.csrfToken = state.csrfToken;
  }

  _dispatch(action, input = {}) {
    const call = this._queue.then(async () => {
      const output = decode(await runPythonWorker(action, { state: this._state, ...input }));
      if (output.state) this._syncState(output.state);
      if (!output.ok) throw new Error(output.error || `${action} 失败`);
      return output.result;
    });
    this._queue = call.catch(() => {});
    return call;
  }

  cookieHeader() {
    return decode(runPythonWorkerSync("cloudtest-client-headers", { state: this._state })).cookieHeader;
  }

  authExpireTimeMs() {
    return decode(runPythonWorkerSync("cloudtest-client-expiry", { state: this._state }));
  }

  authCookie() {
    return decode(runPythonWorkerSync("cloudtest-client-headers", { state: this._state })).authCookie;
  }

  baseHeaders(json = false) {
    return decode(runPythonWorkerSync("cloudtest-client-headers", { state: this._state, json })).baseHeaders;
  }

  async refreshAuth({ timeoutMs = 30_000 } = {}) {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this._dispatch("cloudtest-client-refresh", { timeoutMs });
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  async bootstrapAuth() {
    await this.refreshAuth();
    const expire = this.authExpireTimeMs();
    return expire ? new Date(expire).toISOString() : "";
  }

  request(method, pathname, options = {}) {
    return this._dispatch("cloudtest-client-request", { method, pathname, options });
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
  async putObject(obs, filePath, expectedDigest) {
    const input = Buffer.isBuffer(filePath)
      ? { obs, bytesBase64: filePath.toString("base64"), expectedDigest }
      : { obs, filePath: String(filePath), expectedDigest };
    return this._dispatch("cloudtest-client-upload", input);
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

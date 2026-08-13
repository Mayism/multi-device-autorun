// uploader.mjs
// AGC 云存储上传客户端：OAuth2 鉴权 + PUT 上传 + 3 次重试。
// 参考上传流程.md 中的 AgcCloudStorageClient 实现。

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const TOKEN_URL = "https://connect-api.cloud.huawei.com/api/oauth2/v1/token";
const UPLOAD_HOSTS = {
  CN: "https://ops-server-drcn.agcstorage.link",
  RU: "https://ops-server-drru.agcstorage.link",
  SG: "https://ops-server-dra.agcstorage.link",
  DE: "https://ops-server-dre.agcstorage.link",
};
const DOWNLOAD_HOSTS = {
  CN: "https://agc-storage-drcn.platform.dbankcloud.cn",
  RU: "https://agc-storage-drru.platform.dbankcloud.cn",
  SG: "https://agc-storage-dra.platform.dbankcloud.cn",
  DE: "https://agc-storage-dre.platform.dbankcloud.cn",
};

// AGC 云存储凭证（硬编码，无需配置）
export const UPLOAD_CONFIG = {
  projectId: "101653523863784643",
  clientId: "1946332846855610624",
  clientSecret: "81A2A59F2616F487A72FF83FE4604729ED206B08388D1B2770B102B1052CC07F",
  bucketName: "agent-bench-zc9kf",
  region: "CN",
  prefix: "ohostest",
  maxRetries: 3,
};

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken(config) {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  const body = JSON.stringify({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`获取 OAuth2 token 失败: HTTP ${res.status} ${text}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error("OAuth2 响应缺少 access_token");
  cachedToken = data.access_token;
  const expiresIn = Number(data.expires_in) || 3600;
  tokenExpiresAt = Date.now() + Math.max(expiresIn - 60, 60) * 1000;
  return cachedToken;
}

/**
 * 上传字节数据到 AGC 云存储。
 * @param {object} config — { projectId, clientId, clientSecret, bucketName, region, prefix, maxRetries }
 * @param {Uint8Array} content — 文件内容
 * @param {string} objectName — 对象名（不含 bucket）
 * @param {function} [onLog] — 日志回调 (message) => void
 * @returns {Promise<{url: string, objectName: string}>}
 */
export async function uploadBytes(config, content, objectName, onLog) {
  const region = String(config.region || "CN").toUpperCase();
  const uploadHost = UPLOAD_HOSTS[region] || UPLOAD_HOSTS.CN;
  const bucket = config.bucketName;
  const maxRetries = Math.max(1, Number(config.maxRetries) || 3);
  const encodedName = encodeURIComponent(objectName).replace(/%2F/g, "/");
  const uploadUrl = `${uploadHost}/v0/${bucket}/${encodedName}`;

  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const token = await getAccessToken(config);
      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/zip",
          "Content-Length": String(content.length),
          "X-Agc-File-Size": String(content.length),
          "X-Agc-Trace-Id": randomUUID(),
          client_id: config.clientId,
          productId: config.projectId,
        },
        body: content,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${text}`);
      }
      const data = await res.json().catch(() => ({}));
      const downloadHost = DOWNLOAD_HOSTS[region] || DOWNLOAD_HOSTS.CN;
      const downloadEncoded = encodeURIComponent(objectName);
      const shareToken = data.share_token || data.token || "";
      const baseUrl = `${downloadHost}/v0/${bucket}/${downloadEncoded}`;
      const url = data.shared_download_url
        || data.download_url
        || (shareToken ? `${baseUrl}?token=${shareToken}` : baseUrl);
      onLog?.(`上传成功（第 ${attempt} 次）: ${objectName}`);
      return { url, objectName, attempt };
    } catch (error) {
      lastError = error;
      onLog?.(`上传失败（第 ${attempt}/${maxRetries} 次）: ${error.message}`);
      if (attempt < maxRetries) await delay(1000 * attempt);
    }
  }
  throw new Error(`上传失败（重试 ${maxRetries} 次）: ${lastError?.message || lastError}`);
}

export { getAccessToken };

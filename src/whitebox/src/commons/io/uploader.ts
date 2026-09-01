import { RemoteCallbackPayload } from "../../types.js";
import { fetchWithNetworkLogging } from "./networkLogger.js";

async function postJson(
  endpoint: string | undefined,
  headers: Record<string, string>,
  payload: unknown,
  missingEndpointMessage: string,
  successMessage: string,
): Promise<{ uploaded: boolean; message: string }> {
  if (!endpoint) {
    return { uploaded: false, message: missingEndpointMessage };
  }

  const response = await fetchWithNetworkLogging(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    return { uploaded: false, message: `上传失败，状态码：${response.status}` };
  }

  return { uploaded: true, message: successMessage };
}

export async function uploadTaskCallback(
  endpoint: string | undefined,
  _token: string | undefined,
  payload: RemoteCallbackPayload,
): Promise<{ uploaded: boolean; message: string }> {
  return postJson(
    endpoint,
    {},
    payload,
    "未提供 callback，已跳过回传。",
    "callback 上传成功。",
  );
}

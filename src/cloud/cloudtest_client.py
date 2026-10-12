"""AGC CloudTest authentication and HTTP transport for Python orchestration."""

import base64
import datetime as dt
import hashlib
import json
import os
import re
import ssl
import time
from pathlib import Path
from urllib import error, parse, request

DEFAULT_BASE_URL = "https://agc-drcn.developer.huawei.com/agc/edge/cloudTest/2/apptest/task"
REPORT_BASE_URL = "https://agc-drcn.developer.huawei.com/agc/edge/cloudTest/2/apptest/report"
REFRESH_URL = "https://agc-drcn.developer.huawei.com/agc/edge/oauth2/v1/refresh"


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _pairs(value):
    pairs = {}
    for part in str(value or "").split(";"):
        if "=" in part:
            key, val = part.split("=", 1)
            if key.strip():
                pairs[key.strip()] = val.strip()
    return pairs


def extract_token_json(value):
    raw = re.sub(r"[\r\n]+", "", str(value or "").strip())
    if not raw:
        raise ValueError("cookie 为空")
    if ";" in raw:
        jar = _pairs(raw)
        candidates = (jar.get("agc_authInfo"), jar.get("authInfo"))
    elif raw.startswith("agc_authInfo="):
        candidates = (raw[len("agc_authInfo="):],)
    else:
        candidates = (raw,)
    for candidate in candidates:
        if not candidate:
            continue
        candidate = parse.unquote(candidate)
        if candidate.startswith('"') and candidate.endswith('"'):
            candidate = candidate[1:-1].replace('\\"', '"').replace("\\\\", "\\")
        try:
            info = json.loads(candidate)
        except (ValueError, TypeError):
            continue
        if isinstance(info, dict) and (info.get("accesstoken") or info.get("accessToken")):
            return candidate
    raise ValueError("无法从 cookie 中解析出 authInfo token JSON（应包含 accesstoken 字段）")


def auth_cookie(state):
    return "agc_authInfo=" + parse.quote(state["tokenJson"], safe="~()*!.'-")


def initialize(settings):
    for key, label in (("teamId", "teamId"), ("projectId", "projectId"), ("agcAuthInfo", "agcAuthInfo（agc_authInfo 值或整行 cookie）")):
        if not settings.get(key):
            raise ValueError(f"缺少 cloudTest.{label}")
    raw = re.sub(r"[\r\n]+", "", str(settings["agcAuthInfo"]).strip())
    if ";" in raw:
        jar = _pairs(raw)
    elif raw.startswith("agc_authInfo="):
        jar = _pairs(raw)
    else:
        jar = {"agc_authInfo": parse.quote(extract_token_json(raw), safe="~()*!.'-")}
    if "agc_authInfo" not in jar and "authInfo" in jar:
        jar["agc_authInfo"] = parse.quote(extract_token_json(jar["authInfo"]), safe="~()*!.'-")
    return {
        "teamId": str(settings["teamId"]),
        "projectId": str(settings["projectId"]),
        "tokenJson": extract_token_json(raw),
        "csrfToken": str(jar.get("csrfToken") or ""),
        "cookieJar": jar,
        "baseUrl": str(settings.get("baseUrl") or DEFAULT_BASE_URL).rstrip("/"),
        "reportBaseUrl": str(settings.get("reportBaseUrl") or REPORT_BASE_URL).rstrip("/"),
        "refreshUrl": str(settings.get("refreshUrl") or REFRESH_URL),
        "proxy": str(settings.get("proxy") or "").strip(),
    }


def expiry_ms(state):
    try:
        info = json.loads(state["tokenJson"])
        raw = str(info.get("expiretime") or info.get("expiresTime") or "")
        stamp = re.fullmatch(r"(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z", raw)
        if stamp:
            return int(dt.datetime.strptime(raw, "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
        created = float(info.get("createtime"))
        duration = float(info.get("expiretime"))
        if created > 1e12 and 0 < duration < 1e6:
            return int(created + duration * 1000)
    except (ValueError, TypeError, KeyError):
        pass
    return 0


class _NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def send_request(url, method, headers=None, body=None, timeout_ms=30000, proxy="", verify_tls=True, ca=None):
    """Return status, UTF-8 body and all Set-Cookie headers, including HTTP errors."""
    headers = {key: str(value) for key, value in (headers or {}).items()}
    if isinstance(body, str):
        body = body.encode("utf-8")
    if body is not None and not any(key.lower() == "content-length" for key in headers):
        headers["Content-Length"] = str(len(body))
    proxy = str(proxy or "").strip()
    if proxy and not re.match(r"^https?://", proxy):
        proxy = "http://" + proxy
    if proxy:
        # A configured OBS proxy takes precedence over NO_PROXY in this worker process.
        os.environ.pop("no_proxy", None)
        os.environ.pop("NO_PROXY", None)
    handlers = [request.ProxyHandler({"http": proxy, "https": proxy} if proxy else {}), _NoRedirect()]
    if not verify_tls:
        handlers.append(request.HTTPSHandler(context=ssl._create_unverified_context()))
    elif ca:
        handlers.append(request.HTTPSHandler(context=ssl.create_default_context(cadata=ca)))
    opener = request.build_opener(*handlers)
    req = request.Request(str(url), data=body, headers=headers, method=method)
    try:
        response = opener.open(req, timeout=timeout_ms / 1000)
    except error.HTTPError as exc:
        response = exc
    with response:
        raw = response.read()
        return {
            "status": response.status,
            "text": raw.decode("utf-8", errors="replace"),
            "setCookies": response.headers.get_all("Set-Cookie") or [],
        }


def refresh_auth(state, timeout_ms=30000):
    response = send_request(
        state["refreshUrl"], "GET",
        {"Cookie": auth_cookie(state), "Content-Type": "application/json"},
        _json({"agcTeamId": state["teamId"]}), timeout_ms,
    )
    text = response["text"]
    if response["status"] >= 400:
        detail = "refreshToken 已失效（可能已被其它端使用），请更新 AGC_AUTH_INFO 或 src/cloud/agc-cookie.txt" if re.search(r"get refreshToken failed", text, re.I) else text[:200]
        raise RuntimeError(f"刷新登录态失败: HTTP {response['status']}: {detail}")
    try:
        payload = json.loads(text) if text else {}
    except ValueError:
        payload = {}
    data = payload.get("data", payload) if isinstance(payload, dict) else {}
    if not isinstance(data, dict):
        data = {}
    for raw in response["setCookies"]:
        if raw.startswith("agc_authInfo="):
            state["tokenJson"] = extract_token_json(parse.unquote(raw[len("agc_authInfo="):].split(";", 1)[0]))
            break
    csrf = data.get("csrfToken") or data.get("csrftoken") or (payload.get("csrfToken") if isinstance(payload, dict) else None)
    if csrf:
        state["csrfToken"] = str(csrf)
    return {"tokenJson": state["tokenJson"], "csrfToken": state["csrfToken"], "payload": payload}


def _base_headers(state, json_body=False):
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Cookie": auth_cookie(state),
        "agcTeamId": state["teamId"],
        "productId": state["projectId"],
        "agcCsrfToken": state["csrfToken"],
    }
    if json_body:
        headers["Content-Type"] = "application/json"
    return headers


def _target_url(state, pathname, query, root):
    base = state["reportBaseUrl"] if root == "report" else state["baseUrl"]
    target = base + "/" + str(pathname).lstrip("/")
    pairs = []
    for key, value in (query or {}).items():
        if isinstance(value, list):
            pairs.extend((key, str(item)) for item in value)
        elif value is not None:
            pairs.append((key, str(value)))
    return target + ("?" + parse.urlencode(pairs) if pairs else "")


def api_request(state, method, pathname, options):
    body_provided = "body" in options
    body = _json(options["body"]) if body_provided else None
    timeout_ms = options.get("timeoutMs", 30000)
    retries = max(0, int(options.get("retries", 2)))
    url = _target_url(state, pathname, options.get("query"), options.get("root", "task"))
    refreshed = False
    last_error = None
    for attempt in range(1, retries + 2):
        try:
            response = send_request(url, method, _base_headers(state, body_provided), body, timeout_ms)
        except Exception as exc:
            last_error = exc
            if attempt > retries:
                break
            time.sleep(attempt)
            continue
        status, text = response["status"], response["text"]
        if status in (401, 403) and not refreshed:
            refreshed = True
            try:
                refresh_auth(state)
            except Exception as exc:
                raise RuntimeError(f"HTTP {status}，且 refresh 轮换失败: {exc}") from exc
            last_error = RuntimeError(f"HTTP {status}（已 refresh 轮换登录态重试）")
            continue
        if status in (401, 403):
            hint = "csrfToken 校验失败" if "csrf" in text.lower() else "登录态失效且 refresh 轮换失败：请更新 AGC_AUTH_INFO 或 src/cloud/agc-cookie.txt"
            raise RuntimeError(f"HTTP {status}（{hint}）: {text[:200]}")
        if status >= 400:
            last_error = RuntimeError(f"HTTP {status}: {text[:200]}")
            if attempt > retries:
                break
            time.sleep(attempt)
            continue
        try:
            payload = json.loads(text)
        except ValueError:
            last_error = RuntimeError(f"响应不是合法 JSON: {text[:200]}")
            break
        if isinstance(payload, dict):
            if payload.get("result") is False:
                last_error = RuntimeError(f"errorCode={payload.get('errorCode')} {payload.get('message') or ''}".strip())
                break
            if "code" in payload and payload["code"] != 200:
                last_error = RuntimeError(f"code={payload['code']} {payload.get('msg') or ''}".strip())
                break
        return payload
    raise RuntimeError(f"{method} {pathname} 失败: {last_error}")


def put_object(obs, file_path, proxy, data=None, expected_digest=None):
    headers = {key: value for key, value in (obs.get("headers") or {}).items() if key.lower() != "connection"}
    data = data if data is not None else Path(file_path).read_bytes()
    if expected_digest:
        if len(data) != expected_digest["fileSize"] or hashlib.sha256(data).hexdigest() != expected_digest["sha256"]:
            raise RuntimeError("待上传包在计算摘要后发生变化，请重新计算并申请上传凭证")
    response = send_request(
        obs["url"], obs.get("method") or "PUT", headers,
        data, 300000, proxy, not bool(proxy),
    )
    if response["status"] >= 400:
        raise RuntimeError(f"OBS 上传失败: HTTP {response['status']}: {response['text'][:300]}")
    return True


def digest(file_path):
    file_path = Path(file_path)
    sha = hashlib.sha256()
    size = 0
    with file_path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            sha.update(chunk)
            size += len(chunk)
    return {"appPath": str(file_path), "fileName": file_path.name, "fileSize": size, "sha256": sha.hexdigest()}


TASKGROUP_QUERY = {
    "name": "", "currentPage": "1", "pageSize": "50",
    "createTypes": "51,68,70,55,56,72,18", "taskGroupStatus": "1,2,3,4,5,6",
    "resultStatus": "1,2", "taskType": "1,2,3,6,27,28,14,18",
    "appTypes": "1,10,11,5,6,7,8,33",
}


class CloudTestClient:
    """Direct Python AGC client; uses the transport already exercised by the worker."""

    def __init__(self, settings):
        self.state = initialize(settings)
        self.team_id = self.state["teamId"]
        self.project_id = self.state["projectId"]

    def refresh_auth(self, timeout_ms=30000):
        return refresh_auth(self.state, timeout_ms)

    def auth_expire_time_ms(self):
        return expiry_ms(self.state)

    def request(self, method, pathname, options=None):
        return api_request(self.state, method, pathname, options or {})

    def list_apps(self, page_size=100):
        return ((self.request("GET", f"app/list/1/{page_size}/1").get("data") or {}).get("listResult") or [])

    def request_upload_url(self, file_name, file_size, sha256):
        payload = self.request("POST", "nsp/upload", {"body": {"fileSize": file_size,
                                                              "fileName": file_name, "sha256": sha256}})
        data = payload.get("data")
        try:
            obs = json.loads(data) if isinstance(data, str) else data
        except ValueError as exc:
            raise ValueError(f"nsp/upload 返回的 data 无法解析: {data}") from exc
        if not isinstance(obs, dict) or not obs.get("url") or not obs.get("headers"):
            raise ValueError(f"nsp/upload 返回缺少 url/headers: {str(obs)[:300]}")
        return obs

    def put_object(self, obs, file_path, expected_digest=None):
        return put_object(obs, file_path, self.state["proxy"], expected_digest=expected_digest)

    def trigger_analyze(self, object_id):
        return self.request("GET", "app/down/analyze", {"query": {"objectId": object_id}})

    def get_analyze_status(self, object_id):
        return self.request("GET", f"app/analyze/{parse.quote(str(object_id), safe='')}")

    def poll_analyze(self, object_id, timeout_ms=600000, interval_ms=3000, on_progress=None):
        deadline = time.monotonic() + timeout_ms / 1000
        last_step = ""
        while time.monotonic() < deadline:
            data = (self.get_analyze_status(object_id).get("data") or {})
            step = str(data.get("step") or "")
            if step != last_step:
                if on_progress:
                    on_progress(f"包解析进度: {step or '<unknown>'}")
                last_step = step
            if step == "finishAnalyze":
                if data.get("result") is False:
                    detail = data.get("errorMessageCn") or data.get("errorMessageEn") or data.get("message") or ""
                    raise RuntimeError(f"包解析失败: {detail}（errorCode={data.get('errorCode')}）")
                app = data.get("uploadAppRsp") or {}
                if not app.get("id"):
                    raise RuntimeError(f"包解析完成但缺少 uploadAppRsp.id: {str(data)[:300]}")
                return app
            time.sleep(interval_ms / 1000)
        raise TimeoutError(f"等待包解析超时（{round(timeout_ms / 1000)} 秒，最后步骤: {last_step or 'none'}）")

    def list_business_devices(self, app_type, test_categories, api_levels):
        def serialize(value):
            return ",".join(map(str, value)) if isinstance(value, list) else str(value or "")
        payload = self.request("GET", "business/device/list", {"query": {
            "appType": app_type, "testCategories": serialize(test_categories), "apiLevels": serialize(api_levels)}})
        return ((payload.get("data") or {}).get("deviceList") or [])

    def predict_confirm(self, payload):
        return self.request("POST", "business/quota/predictConfirm", {"body": payload})

    def submit_task(self, payload):
        result = self.request("POST", "task/submit", {"body": payload})
        task_group_id = result.get("data")
        if not task_group_id:
            raise ValueError(f"task/submit 未返回任务组 id: {str(result)[:300]}")
        return str(task_group_id)

    def list_task_groups(self):
        return ((self.request("GET", "task/taskgroups", {"query": TASKGROUP_QUERY}).get("data") or {})
                .get("listResult") or [])

    def get_report_apps(self, task_group_id):
        return self.request("GET", f"report/developer/apps/{task_group_id}",
                            {"query": {"productId": self.project_id}}).get("data") or []

    def get_overview_result(self, task_group_id):
        return self.request("GET", "report/overview/result", {"root": "report",
                           "query": {"taskGroupId": task_group_id, "productId": self.project_id}}).get("data")

    def get_overview_problem(self, task_group_id, category):
        return self.request("GET", "report/overview/problem", {"root": "report",
                           "query": {"taskGroupId": task_group_id, "category": category,
                                     "productId": self.project_id}}).get("data") or []

    def get_report_task_list(self, task_group_id, category):
        return self.request("GET", "report/task/list", {"root": "report",
                           "query": {"taskGroupId": task_group_id, "category": category,
                                     "productId": self.project_id}}).get("data") or []

    def get_dev_report_title(self, task_group_id, category):
        return self.request("GET", f"devReportTitle/list/{task_group_id}/{category}", {"root": "report",
                           "query": {"productId": self.project_id}}).get("data") or []


def dispatch(action, payload):
    if action == "cloudtest-client-init":
        return initialize(payload)
    if action == "cloudtest-client-extract-token":
        return extract_token_json(payload.get("value"))
    if action == "cloudtest-client-expiry":
        return expiry_ms(payload["state"])
    if action == "cloudtest-client-headers":
        state = payload["state"]
        return {
            "cookieHeader": "; ".join(f"{key}={value}" for key, value in state["cookieJar"].items()),
            "authCookie": auth_cookie(state),
            "baseHeaders": _base_headers(state, payload.get("json", False)),
        }
    if action == "cloudtest-client-digest":
        return digest(payload["appPath"])
    if action == "cloudtest-client-send":
        body = payload.get("body")
        if payload.get("bodyBase64") is not None:
            body = base64.b64decode(payload["bodyBase64"])
        return send_request(payload["url"], payload["method"], payload.get("headers"), body,
                            payload.get("timeoutMs", 30000), payload.get("proxy", ""), payload.get("verifyTls", True),
                            payload.get("ca"))
    state = payload.get("state")
    if action in ("cloudtest-client-refresh", "cloudtest-client-request", "cloudtest-client-upload"):
        try:
            if action == "cloudtest-client-refresh":
                result = refresh_auth(state, payload.get("timeoutMs", 30000))
            elif action == "cloudtest-client-request":
                result = api_request(state, payload["method"], payload["pathname"], payload.get("options") or {})
            else:
                encoded = payload.get("bytesBase64")
                result = put_object(payload["obs"], payload.get("filePath"), state["proxy"],
                                    base64.b64decode(encoded) if encoded is not None else None,
                                    payload.get("expectedDigest"))
            return {"ok": True, "result": result, "state": state}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "state": state}
    raise ValueError(f"unknown cloudtest client action: {action}")

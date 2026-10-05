"""OpenCode HTTP client without a Node or third-party HTTP dependency."""

import asyncio
import json
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit, urlunsplit, parse_qsl
from urllib.request import Request, build_opener, ProxyHandler


class OpenCodeHttpError(RuntimeError):
    def __init__(self, message, status=0, body=None):
        super().__init__(message)
        self.status = status
        self.body = body


def _parse_body(body):
    if not body:
        return None
    try:
        return json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return body


class OpenCodeClient:
    def __init__(self, base_url):
        self.base_url = str(base_url or "").rstrip("/")
        # OpenCode runs on loopback; ambient HTTP proxies must not intercept it.
        self._opener = build_opener(ProxyHandler({}))

    def _request_sync(self, pathname, method, body, directory, timeout_sec, raw, headers):
        url = self.base_url + pathname
        if directory:
            split = urlsplit(url)
            query = parse_qsl(split.query, keep_blank_values=True)
            query = [(key, value) for key, value in query if key != "directory"]
            query.append(("directory", directory))
            url = urlunsplit((split.scheme, split.netloc, split.path, urlencode(query), split.fragment))
        request_headers = dict(headers or {})
        if directory:
            request_headers["x-opencode-directory"] = directory
        data = None
        if body is not None:
            if not any(key.lower() == "content-type" for key in request_headers):
                request_headers["Content-Type"] = "application/json"
            data = body.encode("utf-8") if isinstance(body, str) else json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = Request(url, data=data, headers=request_headers, method=method)
        try:
            with self._opener.open(request, timeout=max(1, timeout_sec)) as response:
                content = response.read().decode("utf-8")
                return content if raw else _parse_body(content)
        except HTTPError as error:
            content = error.read().decode("utf-8", errors="replace")
            raise OpenCodeHttpError(f"{method} {pathname} 返回 HTTP {error.code}", error.code,
                                    _parse_body(content)) from error
        except (URLError, TimeoutError, OSError) as error:
            raise OpenCodeHttpError(f"{method} {pathname} 请求失败: {error}", body=error) from error

    async def request(self, pathname, *, method="GET", body=None, directory="", timeout_sec=10,
                      raw=False, headers=None):
        return await asyncio.to_thread(self._request_sync, pathname, method, body, directory,
                                       timeout_sec, raw, headers)

    async def health(self, timeout_sec=3):
        try:
            result = await self.request("/global/health", timeout_sec=timeout_sec)
            return bool(result.get("healthy", True)) if isinstance(result, dict) else True
        except OpenCodeHttpError:
            return False

    async def wait_until_healthy(self, timeout_sec=120, interval_ms=1000):
        deadline = asyncio.get_running_loop().time() + timeout_sec
        while asyncio.get_running_loop().time() < deadline:
            if await self.health():
                return True
            await asyncio.sleep(interval_ms / 1000)
        return False

    async def get_config(self, timeout_sec=30, directory=""):
        return await self.request("/config", timeout_sec=timeout_sec, directory=directory)

    async def get_providers(self, directory="", timeout_sec=30):
        return await self.request("/config/providers", directory=directory, timeout_sec=timeout_sec)

    async def resolve_model(self, model_id, timeout_sec=30):
        config = await self.get_config(timeout_sec)
        for provider_id, provider in (config.get("provider") or {}).items():
            if model_id in ((provider or {}).get("models") or {}):
                return {"providerId": provider_id, "modelId": model_id}
        raise ValueError(f"OpenCode Server 配置中未找到模型: {model_id}")

    async def validate_agent(self, agent_name, timeout_sec=30):
        config = await self.get_config(timeout_sec)
        if agent_name not in (config.get("agent") or {}):
            raise ValueError(f"OpenCode Server 配置中未找到 Agent: {agent_name}")
        return True

    async def create_session(self, directory, timeout_sec=30):
        return await self.request("/session", method="POST", body={}, directory=directory,
                                  timeout_sec=timeout_sec)

    async def prompt_async(self, session_id, payload, directory, timeout_sec=300):
        return await self.request(f"/session/{quote(str(session_id), safe='')}/prompt_async", method="POST",
                                  body=payload, directory=directory, timeout_sec=timeout_sec)

    async def send_message_text(self, session_id, payload, directory, timeout_sec=120):
        return await self.request(f"/session/{quote(str(session_id), safe='')}/message", method="POST",
                                  body=payload, directory=directory, timeout_sec=timeout_sec, raw=True)

    async def list_messages(self, session_id, limit=1, timeout_sec=10):
        suffix = f"?limit={quote(str(limit), safe='')}" if limit else ""
        return await self.request(f"/session/{quote(str(session_id), safe='')}/message{suffix}",
                                  timeout_sec=timeout_sec)

    async def list_children(self, session_id, directory, timeout_sec=10):
        return await self.request(f"/session/{quote(str(session_id), safe='')}/children",
                                  directory=directory, timeout_sec=timeout_sec)

    async def list_todos(self, session_id, timeout_sec=10):
        return await self.request(f"/session/{quote(str(session_id), safe='')}/todo", timeout_sec=timeout_sec)

    async def list_skills(self, directory, timeout_sec=30):
        return await self.request("/skill", directory=directory, timeout_sec=timeout_sec)

    async def list_questions(self, directory, timeout_sec=10):
        return await self.request("/question", directory=directory, timeout_sec=timeout_sec)

    async def list_permissions(self, directory, timeout_sec=10):
        return await self.request("/permission", directory=directory, timeout_sec=timeout_sec)

    async def reply_question(self, request_id, answers, directory, timeout_sec=30):
        return await self.request(f"/question/{quote(str(request_id), safe='')}/reply", method="POST",
                                  body={"answers": answers}, directory=directory, timeout_sec=timeout_sec)

    async def reply_permission(self, request_id, directory, reply="once", timeout_sec=30):
        return await self.request(f"/permission/{quote(str(request_id), safe='')}/reply", method="POST",
                                  body={"reply": reply}, directory=directory, timeout_sec=timeout_sec)

    async def abort_session(self, session_id, directory, timeout_sec=10):
        return await self.request(f"/session/{quote(str(session_id), safe='')}/abort", method="POST",
                                  directory=directory, timeout_sec=timeout_sec)

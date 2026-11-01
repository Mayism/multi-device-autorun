"""Explicit JSON/SSE/submit-poll protocols for remote agent-backed endpoints."""

import json
import os
import re
import time
from urllib.parse import urljoin
from urllib.request import Request, build_opener, ProxyHandler

from pyautorun.harmony_eval.core import Registry

protocols = Registry("http_protocols")


def lookup(value, path):
    for key in str(path).split(".") if path else []:
        value = value[int(key)] if isinstance(value, list) else value[key]
    return value


def substitute(value, case, extra=None):
    if isinstance(value, dict):
        return {k: substitute(v, case, extra) for k, v in value.items()}
    if isinstance(value, list):
        return [substitute(v, case, extra) for v in value]
    if not isinstance(value, str):
        return value
    def replace(match):
        variable = match.group(1)
        if variable.startswith("env:"):
            name = variable[4:]
            if name not in os.environ:
                raise ValueError(f"缺少 HTTP 认证环境变量: {name}")
            return os.environ[name]
        if variable.startswith("case."):
            key = variable[5:]
            if key not in ("question", "case_id"):
                raise ValueError(f"不允许的公开用例变量: {variable}")
            return str(case[key])
        if extra and variable in extra:
            return str(extra[variable])
        raise ValueError(f"未知请求变量: {variable}")
    return re.sub(r"\$\{([^}]+)\}", replace, value)


def open_request(url, method, request, timeout):
    headers = dict(request.get("headers", {}))
    payload = request.get("json")
    body = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
    if body is not None:
        headers.setdefault("Content-Type", "application/json")
    # Loopback should stay usable when corporate proxies are configured.
    from urllib.parse import urlsplit
    opener = build_opener(ProxyHandler({})) if urlsplit(url).hostname in ("127.0.0.1", "localhost", "::1") else build_opener()
    return opener.open(Request(url, data=body, headers=headers, method=method), timeout=timeout)


@protocols.register("json")
class JsonProtocol:
    def call(self, config, case):
        request = substitute(config.get("request", {"json": {"question": "${case.question}"}}), case)
        with open_request(config["http_url"], config.get("method", "POST"), request, config["timeout"]) as response:
            return json.load(response)


@protocols.register("sse")
class SseProtocol:
    def call(self, config, case):
        request = substitute(config.get("request", {"json": {"question": "${case.question}"}}), case)
        field = config.get("response", {}).get("event_answer_path", "delta")
        chunks, events, data_lines = [], [], []
        deadline = time.monotonic() + config["timeout"]
        with open_request(config["http_url"], config.get("method", "POST"), request, config["timeout"]) as response:
            for raw in response:
                if time.monotonic() > deadline:
                    raise TimeoutError("SSE 超过任务时限")
                line = raw.decode().rstrip("\r\n")
                if line.startswith("data:"):
                    data_lines.append(line[5:].lstrip())
                elif not line and data_lines:
                    data = "\n".join(data_lines)
                    data_lines = []
                    if data == "[DONE]":
                        break
                    event = json.loads(data)
                    events.append(event)
                    try:
                        chunks.append(str(lookup(event, field)))
                    except (KeyError, IndexError, TypeError):
                        continue
        return {"answer": "".join(chunks), "events": events}


@protocols.register("async")
@protocols.register("poll")
class PollProtocol:
    def call(self, config, case):
        first = JsonProtocol().call(config, case)
        settings = config["response"]["poll"]
        job = lookup(first, settings.get("job_id_path", "job_id"))
        deadline = time.monotonic() + config["timeout"]
        while time.monotonic() < deadline:
            url = substitute(settings["url"], case, {"job_id": job})
            url = urljoin(config["http_url"], url)
            request = substitute(settings.get("request", {"headers": config.get("request", {}).get("headers", {})}), case)
            with open_request(url, settings.get("method", "GET"), request,
                              max(1, deadline - time.monotonic())) as response:
                result = json.load(response)
            status = lookup(result, settings.get("status_path", "status"))
            if status in settings.get("completed", ["completed", "success"]):
                return result
            if status in settings.get("failed", ["failed", "error"]):
                raise RuntimeError(f"远端 Agent 任务失败: {status}")
            time.sleep(min(settings.get("interval", 1), max(0, deadline - time.monotonic())))
        raise TimeoutError("远端 Agent 轮询超时")


def call_http(config, case):
    response_config = config.get("response", {})
    protocol = response_config.get("protocol", "json")
    data = protocols.get(protocol)().call(config, case)
    answer = lookup(data, response_config.get("answer_path", "answer"))
    if not isinstance(answer, str) or not answer.strip():
        raise ValueError("HTTP Agent 返回答案为空或不是字符串")
    session_path = response_config.get("session_id_path")
    return {"answer": answer, "session_id": lookup(data, session_path) if session_path else None}

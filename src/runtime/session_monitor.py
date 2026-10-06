"""Monitor OpenCode sessions with SSE plus HTTP polling from Python."""

import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import threading
import time
import unicodedata
from urllib.parse import urlencode
from urllib.request import Request

from pyautorun.orchestration.interaction import handle_pending_interactions
from pyautorun.runtime.usage import TokenUsageTracker, CompileUsageTracker


ACTIVE_TODO_STATES = {"pending", "in_progress", "in-progress", "running", "active", "doing", "todo"}
TERMINAL_EXCLUSIONS = {"", "tool-calls", "unknown"}
BASIC_TESTS_REPLY = "仅基础测试"


def quota_exceeded_message(value):
    return bool(re.search(r"使用上限|限额|rate\s*[-_]?limit|usage\s*limit|quota\s*(?:exceeded|limit)?|429", str(value or ""), re.I))


def hard_quota_cap(value):
    return bool(re.search(r"每周|每月|使用上限|限额[^。；]{0,24}重置|weekly|monthly|usage\s*limit|(?:quota|limit)[^.;]{0,32}reset", str(value or ""), re.I))


def _walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child)


def _event_data(payload):
    current = payload
    seen = set()
    while isinstance(current, dict) and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current.get("payload"), dict):
            current = current["payload"]
        elif isinstance(current.get("data"), dict):
            current = current["data"]
        else:
            break
    return current


def _session_ids(payload):
    return {str(node.get("sessionID") or node.get("sessionId") or node.get("session_id"))
            for node in _walk(payload) if node.get("sessionID") or node.get("sessionId") or node.get("session_id")}


def _matches_task(payload, active_session_ids, project_dir):
    ids = _session_ids(payload)
    if ids:
        return bool(ids & active_session_ids)
    directories = {os.path.abspath(node["directory"]) for node in _walk(payload)
                   if isinstance(node.get("directory"), str)}
    expected = os.path.abspath(project_dir)
    if os.name == "nt":
        return expected.lower() in {value.lower() for value in directories}
    return expected in directories


def _parse_sse(block):
    lines = [line[5:].lstrip() for line in block.splitlines() if line.startswith("data:")]
    if not lines:
        return None
    value = "\n".join(lines)
    try:
        return json.loads(value)
    except ValueError:
        return {"event": "sse.raw", "data": value}


class SseCapture:
    def __init__(self, base_url, project_dir, active_ids, events_path, loop):
        self.base_url = base_url.rstrip("/")
        self.project_dir = project_dir
        self.active_ids = active_ids
        self.events_path = Path(events_path)
        self.loop = loop
        self.queue = asyncio.Queue()
        self.stop_event = threading.Event()
        self.response = None
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self.thread.start()
        return self

    def stop(self):
        self.stop_event.set()
        response = self.response
        if response:
            try:
                response.close()
            except OSError:
                pass

    def _emit(self, item):
        self.loop.call_soon_threadsafe(self.queue.put_nowait, item)

    def _append(self, item):
        self.events_path.parent.mkdir(parents=True, exist_ok=True)
        with self.events_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(item, ensure_ascii=False) + "\n")

    def _run(self):
        from urllib.request import build_opener, ProxyHandler
        opener = build_opener(ProxyHandler({}))
        while not self.stop_event.is_set():
            connected = False
            for endpoint in ("/global/event", "/event"):
                if self.stop_event.is_set():
                    break
                url = self.base_url + endpoint + "?" + urlencode({"directory": self.project_dir})
                request = Request(url, headers={"x-opencode-directory": self.project_dir})
                try:
                    with opener.open(request, timeout=5) as response:
                        self.response = response
                        connected = True
                        block = []
                        while not self.stop_event.is_set():
                            try:
                                raw = response.readline()
                            except TimeoutError:
                                continue
                            if not raw:
                                break
                            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                            if line:
                                block.append(line)
                                continue
                            payload = _parse_sse("\n".join(block))
                            block = []
                            if not payload or not _matches_task(payload, self.active_ids, self.project_dir):
                                continue
                            self._append({"timestamp": _iso(), "payload": payload})
                            self._emit(payload)
                except Exception as error:
                    if not self.stop_event.is_set():
                        self._append({"timestamp": _iso(), "event": "sse.error", "error": str(error),
                                      "endpoint": endpoint})
                finally:
                    self.response = None
                if connected:
                    break
            self.stop_event.wait(1)


def _iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _append_jsonl(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(value, ensure_ascii=False) + "\n")


def _latest_assistant(payload):
    values = payload if isinstance(payload, list) else [payload] if payload else []
    for item in reversed(values):
        if not isinstance(item, dict):
            continue
        role = str((item.get("info") or {}).get("role") or item.get("role") or "").lower()
        if not role or role == "assistant":
            return item
    return None


def _parts(message):
    return message.get("parts") or [] if isinstance(message, dict) else []


def _extract_text(message):
    return "\n".join(part["text"] for part in _parts(message)
                     if part.get("type") == "text" and isinstance(part.get("text"), str)).strip()


def requests_basic_tests_reply(message):
    text = unicodedata.normalize("NFKC", _extract_text(message))
    text = re.sub(r"\*\*|__|`", "", text)
    text = re.sub(r"[ \t]+", " ", text)
    return ("当前模型未通过图片理解探测" in text and "仅基础测试" in text and
            bool(re.search(r"请回复\s*[“\"'‘]?\s*仅基础测试\s*[”\"'’]?", text)))


def _finish_reason(message):
    return str((message or {}).get("info", {}).get("finish") or "").strip().lower()


def _has_step_finish(message):
    return any(str(part.get("type") or "").lower() == "step-finish" for part in _parts(message))


def _terminal(message):
    return bool(message and _has_step_finish(message) and _finish_reason(message) not in TERMINAL_EXCLUSIONS)


def _summarized(value):
    if value is None:
        return None
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True)
    return {"length": len(text), "tail": text[-512:]}


def _signature(message):
    if not message:
        return ""
    meaningful = []
    for part in _parts(message):
        kind = str(part.get("type") or "").lower()
        if kind in ("text", "reasoning") and isinstance(part.get("text"), str) and part["text"].strip():
            meaningful.append({"type": kind, "text": _summarized(part["text"])})
        elif kind == "tool":
            state = part.get("state") or {}
            meaningful.append({"type": kind, "id": part.get("callID") or part.get("callId") or part.get("id") or "",
                               "tool": part.get("tool") or "tool", "status": str(state.get("status") or "pending").lower(),
                               "input": _summarized(state.get("input")),
                               "output": _summarized(state.get("output") or (state.get("metadata") or {}).get("output")),
                               "error": _summarized(state.get("error"))})
        elif kind == "step-finish":
            meaningful.append({"type": kind, "finish": _finish_reason(message)})
    if not meaningful:
        return ""
    return json.dumps({"id": (message.get("info") or {}).get("id") or message.get("id") or "",
                       "finish": _finish_reason(message), "parts": meaningful}, ensure_ascii=False, sort_keys=True)


def _message_progress(message):
    progress = {"outputChars": 0, "reasoningChars": 0, "toolCalls": 0, "latestTool": None,
                "latestPreview": "", "latestPreviewType": ""}
    for part in _parts(message):
        kind = str(part.get("type") or "").lower()
        if kind in ("text", "reasoning") and isinstance(part.get("text"), str):
            progress["outputChars" if kind == "text" else "reasoningChars"] += len(part["text"])
            if part["text"].strip():
                progress["latestPreview"] = part["text"]
                progress["latestPreviewType"] = kind
        elif kind == "tool":
            progress["toolCalls"] += 1
            state = part.get("state") or {}
            progress["latestTool"] = {"name": str(part.get("tool") or "tool"),
                                      "status": str(state.get("status") or "pending").lower(),
                                      "description": str((state.get("metadata") or {}).get("description") or
                                                         (state.get("input") or {}).get("description") or "").strip()}
    return progress


def _todos_active(payload):
    return any(str(node.get("status") or node.get("state") or "").strip().lower() in ACTIVE_TODO_STATES
               for node in _walk(payload))


class SessionMonitorError(RuntimeError):
    def __init__(self, message, code=""):
        super().__init__(message)
        self.code = code


async def run_monitored_session(client, session_id, project_dir, payload, events_path, polling_path,
                                idle_timeout_sec=600, max_runtime_sec=6000, on_progress=None,
                                on_quota_exceeded=None):
    """Submit a prompt and wait for a stable terminal assistant message."""
    active_ids = {session_id}
    idle_sessions = set()
    children = set()
    replied_questions = set()
    replied_permissions = set()
    token_tracker = TokenUsageTracker()
    compile_tracker = CompileUsageTracker()
    child_signatures = {}
    last_activity = started = time.monotonic()
    next_message = next_children = next_todo = next_interaction = 0
    message_poll_sec = 2
    unchanged_count = stable_terminal = 0
    last_signature = ""
    latest_message = None
    todo_active = child_active = False
    pending_basic = None
    basic_injected = quota_limited = False
    interaction_requested = True
    fatal = None
    sse = SseCapture(client.base_url, project_dir, active_ids, events_path,
                     asyncio.get_running_loop()).start()

    def activity():
        nonlocal last_activity
        last_activity = time.monotonic()

    def progress(kind, data):
        if on_progress:
            on_progress(kind, data)

    def basic_request(message, source_id):
        if not requests_basic_tests_reply(message):
            return None
        identifier = str((message.get("info") or {}).get("id") or message.get("id") or "")
        return {"sourceSessionId": source_id, "sourceMessageId": identifier,
                "key": f"{source_id}:{identifier or _signature(message)}", "ready": _terminal(message)}

    try:
        await asyncio.sleep(0.3)
        await client.prompt_async(session_id, payload, project_dir, 300)
        progress("prompt_submitted", {"sessionId": session_id})
        while True:
            while not sse.queue.empty():
                event = sse.queue.get_nowait()
                data = _event_data(event)
                kind = str(data.get("type") or event.get("event") or event.get("type") or "").lower()
                ids = _session_ids(event)
                if kind == "session.idle":
                    idle_sessions.update(ids)
                elif kind == "session.status":
                    status_value = (data.get("properties") or {}).get("status") or (data.get("properties") or {}).get("state") or ""
                    status = str(status_value.get("type") if isinstance(status_value, dict) else status_value).lower()
                    if status == "idle":
                        idle_sessions.update(ids)
                    elif status == "retry":
                        message = str(status_value.get("message") or "") if isinstance(status_value, dict) else ""
                        if quota_exceeded_message(message):
                            quota_limited = True
                            hard = hard_quota_cap(message)
                            if on_quota_exceeded:
                                on_quota_exceeded(message, hard)
                            if hard:
                                fatal = SessionMonitorError(f"API 用量上限，提前停止 Agent：{message}", "AGENT_QUOTA_EXCEEDED")
                if kind == "session.error":
                    raw = (data.get("properties") or {}).get("error") or data.get("error") or {}
                    message = str((raw.get("data") or {}).get("message") or raw.get("message") or "") if isinstance(raw, dict) else str(raw)
                    fatal = SessionMonitorError(f"OpenCode session error{': ' + message if message else ''}",
                                                "OPENCODE_SESSION_ERROR")
                if kind in ("question.asked", "permission.asked"):
                    interaction_requested = True
                progress("sse", {"type": kind})
            if fatal:
                raise fatal
            now = time.monotonic()
            if now - started >= max_runtime_sec:
                raise SessionMonitorError(f"Agent 总运行时间超过 {max_runtime_sec} 秒")
            if now - last_activity >= idle_timeout_sec:
                raise SessionMonitorError(f"Agent 连续 {idle_timeout_sec} 秒无活动")
            if now >= next_message:
                next_message = now + message_poll_sec
                try:
                    raw = await client.list_messages(session_id, 1)
                    latest_message = _latest_assistant(raw) or latest_message
                    request = basic_request(latest_message, session_id)
                    if request and not basic_injected and (pending_basic is None or not pending_basic["ready"]):
                        pending_basic = request
                    usage_changed = token_tracker.update(session_id, latest_message)
                    compile_changed = compile_tracker.update(session_id, latest_message)
                    if usage_changed or compile_changed:
                        activity()
                    signature = _signature(latest_message)
                    changed = bool(signature and signature != last_signature)
                    if changed:
                        last_signature = signature
                        unchanged_count = 0
                        message_poll_sec = 2
                        stable_terminal = 1 if _terminal(latest_message) else 0
                        activity()
                    elif latest_message:
                        unchanged_count += 1
                        if unchanged_count >= 3:
                            message_poll_sec = 10
                        if signature and _terminal(latest_message):
                            stable_terminal += 1
                    _append_jsonl(polling_path, {"timestamp": _iso(), "kind": "message", "sessionId": session_id,
                                                 "changed": changed, "data": raw})
                    progress("message", {"changed": changed, "finish": _finish_reason(latest_message),
                                         "tokenUsage": token_tracker.total(), "compileUsage": compile_tracker.summary(),
                                         **_message_progress(latest_message)})
                except Exception as error:
                    _append_jsonl(polling_path, {"timestamp": _iso(), "kind": "message_error",
                                                 "sessionId": session_id, "error": str(error)})
            if now >= next_children:
                next_children = now + 10
                child_active = False
                try:
                    raw_children = await client.list_children(session_id, project_dir)
                    for item in raw_children if isinstance(raw_children, list) else []:
                        child_id = str(item.get("id") or item.get("sessionID") or item.get("sessionId") or "")
                        if not child_id:
                            continue
                        children.add(child_id)
                        active_ids.add(child_id)
                        try:
                            child_messages = await client.list_messages(child_id, 1)
                            child_message = _latest_assistant(child_messages)
                            request = basic_request(child_message, child_id)
                            if request and not basic_injected and (pending_basic is None or not pending_basic["ready"]):
                                pending_basic = request
                            token_changed = token_tracker.update(child_id, child_message)
                            compile_changed = compile_tracker.update(child_id, child_message)
                            if token_changed or compile_changed:
                                activity()
                                progress("token_usage", {"tokenUsage": token_tracker.total(),
                                                         "compileUsage": compile_tracker.summary()})
                            signature = _signature(child_message)
                            if signature and signature != child_signatures.get(child_id):
                                child_signatures[child_id] = signature
                                activity()
                            if child_id not in idle_sessions and not _terminal(child_message):
                                child_active = True
                        except Exception:
                            child_active = True
                    _append_jsonl(polling_path, {"timestamp": _iso(), "kind": "children", "sessionId": session_id,
                                                 "data": raw_children})
                except Exception:
                    pass
            if now >= next_todo:
                next_todo = now + 60
                todo_active = False
                for target_id in (session_id, *children):
                    try:
                        todos = await client.list_todos(target_id)
                        todo_active = todo_active or _todos_active(todos)
                        _append_jsonl(polling_path, {"timestamp": _iso(), "kind": "todo", "sessionId": target_id,
                                                     "data": todos})
                    except Exception:
                        pass
            if interaction_requested or now >= next_interaction:
                interaction_requested = False
                next_interaction = now + 2
                await handle_pending_interactions(client, project_dir, replied_questions, replied_permissions,
                                                  activity, progress)
            if not basic_injected and pending_basic and pending_basic["ready"]:
                pending = await handle_pending_interactions(client, project_dir, replied_questions,
                                                            replied_permissions, activity, progress)
                if pending["pending"] or pending["errors"]:
                    await asyncio.sleep(0.5)
                    continue
                reply = pending_basic
                await client.prompt_async(session_id, {**payload, "parts": [{"type": "text", "text": BASIC_TESTS_REPLY}]},
                                          project_dir, 300)
                basic_injected = True
                pending_basic = None
                idle_sessions.discard(session_id)
                latest_message = None
                todo_active = child_active = False
                stable_terminal = unchanged_count = 0
                message_poll_sec = 2
                next_message = next_children = next_todo = 0
                activity()
                _append_jsonl(polling_path, {"timestamp": _iso(), "kind": "automatic_text_reply",
                                             "sessionId": session_id, "text": BASIC_TESTS_REPLY,
                                             "sourceSessionId": reply["sourceSessionId"],
                                             "sourceMessageId": reply["sourceMessageId"]})
                continue
            complete = (_terminal(latest_message) and not todo_active and not child_active and
                        (session_id in idle_sessions or stable_terminal >= 2))
            if (latest_message and _has_step_finish(latest_message) and _finish_reason(latest_message) == "unknown"
                    and session_id in idle_sessions):
                raise SessionMonitorError("OpenCode session 已 idle，但模型 finish reason 为 unknown")
            if complete:
                pending = await handle_pending_interactions(client, project_dir, replied_questions,
                                                            replied_permissions, activity, progress)
                if pending["pending"] or pending["errors"]:
                    await asyncio.sleep(0.5)
                    continue
                return {"status": "completed", "sessionId": session_id, "childSessionIds": list(children),
                        "finishReason": _finish_reason(latest_message), "output": _extract_text(latest_message),
                        "message": latest_message, "tokenUsage": token_tracker.total(),
                        "compileUsage": compile_tracker.summary(), "elapsedSec": round(now - started),
                        "quotaLimited": quota_limited}
            await asyncio.sleep(0.5)
    except BaseException as error:
        await asyncio.gather(*(client.abort_session(identifier, project_dir) for identifier in (session_id, *children)),
                             return_exceptions=True)
        error.session_id = session_id
        error.child_session_ids = list(children)
        error.last_message = latest_message
        error.token_usage = token_tracker.total()
        error.quota_limited = quota_limited
        raise
    finally:
        sse.stop()

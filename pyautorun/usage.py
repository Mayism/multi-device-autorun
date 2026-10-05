"""Token and HarmonyOS compile usage accounting for OpenCode sessions."""

from datetime import datetime, timezone
import math
import re


TOKEN_FIELDS = ("input", "output", "reasoning", "cacheRead", "cacheWrite", "total", "cost")
COMPILE_FIELDS = ("attempts", "succeeded", "failed", "interrupted", "running")
_TASKS = re.compile(r"\b(?:assemble(?:hap|har|hsp|app)|build(?:hap|har|hsp|app)?|packageapp|signapp)\b", re.I)
_INTERRUPTED = re.compile(r"\b(?:abort(?:ed)?|cancel(?:led)?|interrupt(?:ed)?)\b|已中断|已取消|工具执行已中止", re.I)


def _obj(value):
    return value if isinstance(value, dict) else {}


def _list(value):
    return value if isinstance(value, list) else []


def _number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) and result > 0 else 0
    except (TypeError, ValueError):
        return 0


def empty_token_usage():
    return {field: 0 for field in TOKEN_FIELDS}


def message_token_usage(message):
    info = _obj(_obj(message).get("info"))
    tokens = info.get("tokens")
    if not isinstance(tokens, dict):
        return None
    cache = _obj(tokens.get("cache"))
    usage = {"input": _number(tokens.get("input")), "output": _number(tokens.get("output")),
             "reasoning": _number(tokens.get("reasoning")), "cacheRead": _number(cache.get("read")),
             "cacheWrite": _number(cache.get("write")), "total": _number(tokens.get("total")),
             "cost": _number(info.get("cost"))}
    if not usage["total"]:
        usage["total"] = sum(usage[field] for field in TOKEN_FIELDS[:5])
    return usage


def add_token_usage(*values):
    total = empty_token_usage()
    for value in values:
        for field in TOKEN_FIELDS:
            total[field] += _number(_obj(value).get(field))
    total["cost"] = round(total["cost"], 12)
    return total


def aggregate_session_messages(sessions):
    latest = {}
    for session in _list(sessions):
        session = _obj(session)
        session_id = str(session.get("sessionId") or "session")
        for index, message in enumerate(_list(session.get("messages"))):
            usage = message_token_usage(message)
            if usage is None:
                continue
            message = _obj(message)
            identifier = _obj(message.get("info")).get("id") or message.get("id") or f"message-{index}"
            latest[(session_id, str(identifier))] = usage
    return add_token_usage(*latest.values())


class TokenUsageTracker:
    def __init__(self):
        self.messages = {}

    def update(self, session_id, message):
        usage = message_token_usage(message)
        message = _obj(message)
        identifier = _obj(message.get("info")).get("id") or message.get("id")
        if usage is None or not identifier:
            return False
        key = (str(session_id), str(identifier))
        if self.messages.get(key) == usage:
            return False
        self.messages[key] = usage
        return True

    def total(self):
        return add_token_usage(*self.messages.values())


def empty_compile_usage():
    return {field: 0 for field in COMPILE_FIELDS}


def add_compile_usage(*values):
    total = empty_compile_usage()
    for value in values:
        for field in COMPILE_FIELDS:
            total[field] += round(_number(_obj(value).get(field)))
    return total


def _is_harmony_build(command):
    deveco = re.search(r"\bdevecocli(?:\.(?:bat|cmd|js))?\s+build\b(?!\s+clean\b)", command, re.I)
    hvigor = re.search(r"\bhvigorw(?:\.(?:bat|cmd|js))?\b", command, re.I)
    return bool(deveco or (hvigor and _TASKS.search(command)))


def _timestamp(value):
    try:
        number = float(value)
        return datetime.fromtimestamp(number / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (TypeError, ValueError, OverflowError):
        return ""


def _exit_code(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def _classify_attempt(state):
    status = str(state.get("status") or "unknown").strip().lower()
    metadata = _obj(state.get("metadata"))
    output = "\n".join(str(item or "") for item in (state.get("output"), metadata.get("output"), state.get("error")))
    interrupted = metadata.get("interrupted") or _INTERRUPTED.search(str(state.get("error") or "")) or \
        _INTERRUPTED.search(str(metadata.get("error") or ""))
    if interrupted or status in ("aborted", "cancelled", "canceled", "interrupted"):
        return "interrupted"
    if status in ("running", "pending", "unknown"):
        return "running"
    exit_code = _exit_code(metadata.get("exit"))
    if exit_code is not None:
        return "succeeded" if exit_code == 0 else "failed"
    if status in ("error", "failed") or re.search(r"\bBUILD FAILED\b|\bFAILED\s+in\b", output, re.I):
        return "failed"
    return "succeeded"


def collect_compile_attempts(sessions):
    seen = set()
    items = []
    for session in _list(sessions):
        session = _obj(session)
        session_id = str(session.get("sessionId") or "")
        for message_index, message in enumerate(_list(session.get("messages"))):
            for part_index, part in enumerate(_list(_obj(message).get("parts"))):
                part = _obj(part)
                if str(part.get("type") or "").lower() != "tool" or str(part.get("tool") or "").lower() != "bash":
                    continue
                state = _obj(part.get("state"))
                command = str(_obj(state.get("input")).get("command") or "").strip()
                if not _is_harmony_build(command):
                    continue
                call_id = part.get("callID") or part.get("callId") or part.get("id")
                key = (session_id, str(call_id or f"{session_id}:message-{message_index}:part-{part_index}"))
                if key in seen:
                    continue
                seen.add(key)
                metadata = _obj(state.get("metadata"))
                time = _obj(state.get("time"))
                start = _exit_code(time.get("start"))
                end = _exit_code(time.get("end"))
                items.append({"callId": str(call_id or ""), "sessionId": session_id, "command": command,
                              "tasks": _TASKS.findall(command),
                              "toolStatus": str(state.get("status") or "unknown").strip().lower(),
                              "outcome": _classify_attempt(state),
                              "startedAt": _timestamp(time.get("start")),
                              "finishedAt": _timestamp(time.get("end")),
                              "durationMs": round(end - start) if start is not None and end is not None and end >= start else 0,
                              "exitCode": _exit_code(metadata.get("exit")),
                              "description": str(_obj(state.get("input")).get("description") or
                                                 metadata.get("description") or "")})
    usage = empty_compile_usage()
    for item in items:
        usage["attempts"] += 1
        usage[item["outcome"]] += 1
    return {**usage, "items": items}


class CompileUsageTracker:
    def __init__(self):
        self.attempts = {}

    def update(self, session_id, message):
        latest = collect_compile_attempts([{"sessionId": session_id, "messages": [message]}])
        changed = False
        for item in latest["items"]:
            key = (item["sessionId"], item["callId"] or item["command"])
            if self.attempts.get(key) == item:
                continue
            self.attempts[key] = item
            changed = True
        return changed

    def summary(self):
        usage = empty_compile_usage()
        for item in self.attempts.values():
            usage["attempts"] += 1
            usage[item["outcome"]] += 1
        return usage

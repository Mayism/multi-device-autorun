"""Compute the existing autorun-batch-report-v1 data contract."""

import json
import math
from pathlib import Path


def _obj(value):
    return value if isinstance(value, dict) else {}


def _list(value):
    return value if isinstance(value, list) else []


def _truthy(value):
    if isinstance(value, (dict, list)):
        return True
    return bool(value)


def _text(value):
    return value if isinstance(value, str) else ""


def _status(value):
    return _text(value).strip() or "not_started"


def _numeric(value):
    try:
        if value is None:
            return 0
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, str) and not value.strip():
            return 0
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError, OverflowError):
        return None


def _number(value):
    parsed = _numeric(value)
    return math.floor(parsed + 0.5) if parsed is not None and parsed > 0 else 0


def _duration(value):
    parsed = _numeric(value)
    return math.floor(parsed / 1000 + 0.5) if parsed is not None and parsed > 0 else 0


def _read_json(value):
    if not value:
        return None
    try:
        return json.loads(Path(value).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None


def _event_counts(messages_path):
    sessions = _read_json(messages_path)
    if not isinstance(sessions, list):
        return {"modelCalls": 0, "toolCalls": 0, "available": False}
    model_messages = set()
    tool_calls = set()
    for session in sessions:
        session = _obj(session)
        session_id = _text(session.get("sessionId"))
        for message_index, raw_message in enumerate(_list(session.get("messages"))):
            message = _obj(raw_message)
            info = _obj(message.get("info"))
            message_key = f"{session_id}:{_text(info.get('id')) or message_index}"
            if info.get("role") == "assistant" and isinstance(info.get("tokens"), (dict, list)):
                model_messages.add(message_key)
            for part_index, raw_part in enumerate(_list(message.get("parts"))):
                part = _obj(raw_part)
                if str(part.get("type") or "").lower() != "tool":
                    continue
                call_id = (_text(part.get("callID")) or _text(part.get("callId"))
                           or _text(part.get("id")) or f"{message_key}:{part_index}")
                tool_calls.add(f"{session_id}:{call_id}")
    return {"modelCalls": len(model_messages), "toolCalls": len(tool_calls), "available": True}


def _agent_case(raw_result):
    result = _obj(raw_result)
    logs = _obj(result.get("logs"))
    counts = _event_counts(logs.get("messagesPath"))
    usage = _obj(result.get("tokenUsage"))
    compile_usage = _obj(result.get("agentCompile"))
    return {
        "case": _text(result.get("case")),
        "status": _status(result.get("agentStatus") or result.get("status")),
        "elapsedSec": _number(result.get("agentElapsedSec") if result.get("agentElapsedSec") is not None
                              else result.get("elapsedSec")),
        "tokenUsage": {key: _number(usage.get(key)) for key in ("input", "output", "total")},
        "modelCalls": counts["modelCalls"],
        "toolCalls": counts["toolCalls"],
        "compile": {key: _number(compile_usage.get(key)) for key in
                    ("attempts", "succeeded", "failed", "interrupted", "running")},
        "metricsSource": "all-messages.json" if counts["available"] else "unavailable",
        "messagesPath": _text(logs.get("messagesPath")),
        "transcriptPath": _text(logs.get("transcriptPath")),
    }


def _device(raw_device, categories):
    device = _obj(raw_device)
    item = {key: _text(device.get(key)) for key in ("id", "profile", "target")}
    item["status"] = _status(device.get("status"))
    item.update({key: _number(device.get(key)) for key in
                 ("testsRun", "passes", "failures", "errors", "ignored")})
    item["durationSec"] = _duration(device.get("durationMs"))
    suites = []
    for raw_suite in _list(device.get("suiteResults")):
        suite = _obj(raw_suite)
        row = {"name": _text(suite.get("suiteClass")), "status": _status(suite.get("status"))}
        row.update({key: _number(suite.get(key)) for key in
                    ("testsRun", "passes", "failures", "errors", "ignored")})
        row["durationSec"] = _duration(suite.get("durationMs"))
        tests = []
        for raw_test in _list(suite.get("testCases")):
            test = _obj(raw_test)
            name = _text(test.get("name"))
            category = ("fail_to_pass" if name in categories["failToPass"] else
                        "pass_to_pass" if name in categories["passToPass"] else "--")
            tests.append({"name": name, "category": category,
                          "status": _status(test.get("status")),
                          "durationSec": _duration(test.get("durationMs"))})
        row["tests"] = tests
        suites.append(row)
    item["suites"] = suites
    return item


def _ohos_case(raw_result):
    result = _obj(raw_result)
    ohos = _obj(result.get("ohosTest"))
    runner = _read_json(ohos.get("resultPath"))
    runner_obj = _obj(runner)
    swe = _obj(_obj(runner_obj.get("runs")).get("swe"))
    metadata = _obj(runner_obj.get("metadata"))
    categories = {key: set(_list(metadata.get(key))) for key in ("failToPass", "passToPass")}
    run = None
    if runner is not None:
        build = _obj(swe.get("build"))
        run = {
            "status": _status(swe.get("status")), "durationSec": _duration(swe.get("durationMs")),
            "build": {"status": _status(build.get("status")),
                      "durationSec": _duration(build.get("durationMs")),
                      "appHap": _text(build.get("appHap")), "testHap": _text(build.get("testHap"))},
            "devices": [_device(device, categories) for device in _list(swe.get("devices"))],
            "diagnostics": [value for value in map(_text, _list(runner_obj.get("diagnostics"))) if value],
        }
    return {
        "case": _text(result.get("case")), "status": _status(ohos.get("status")),
        "runnerStatus": _text(ohos.get("runnerStatus")), "elapsedSec": _number(ohos.get("elapsedSec")),
        "error": _text(ohos.get("error")), "sourceResultPath": _text(ohos.get("resultPath")),
        "sourceSummaryPath": _text(ohos.get("summaryPath")), "runnerOutputAvailable": _truthy(runner),
        "run": run,
    }


def whitebox_summary(results, enabled):
    cases = [{"case": _text(_obj(item).get("case")), **_obj(_obj(item).get("whitebox"))}
             for item in results if _truthy(_obj(item).get("whitebox"))]
    scores = [_numeric(item["totalScore"]) for item in cases if "totalScore" in item]
    scores = [score for score in scores if score is not None]
    average = math.floor(sum(scores) / len(scores) * 100 + 0.5) / 100 if scores else None
    return {"enabled": enabled is True, "completed": sum(item.get("status") == "completed" for item in cases),
            "failed": sum(item.get("status") != "completed" for item in cases),
            "averageScore": average, "cases": cases}


def build_batch_report(payload):
    summary = _obj(payload.get("summary"))
    results = _list(summary.get("results"))
    agent_cases = [_agent_case(item) for item in results]
    ohos_cases = [_ohos_case(item) for item in results if _truthy(_obj(item).get("ohosTest"))]
    devices = [device for item in ohos_cases for device in _list(_obj(item.get("run")).get("devices"))]
    representative = next((_obj(item) for item in results if any(_obj(item).get(key) for key in
                            ("agent", "providerId", "modelId"))), {})
    agent = {
        "type": _text(summary.get("agent") or representative.get("agent")),
        "providerId": _text(summary.get("providerId") or representative.get("providerId")),
        "modelId": _text(summary.get("modelId") or representative.get("modelId")),
        "inputTokens": sum(item["tokenUsage"]["input"] for item in agent_cases),
        "outputTokens": sum(item["tokenUsage"]["output"] for item in agent_cases),
        "totalTokens": sum(item["tokenUsage"]["total"] for item in agent_cases),
        "modelCalls": sum(item["modelCalls"] for item in agent_cases),
        "toolCalls": sum(item["toolCalls"] for item in agent_cases),
        "compileAttempts": sum(item["compile"]["attempts"] for item in agent_cases),
        "compile": {key: sum(item["compile"][key] for item in agent_cases) for key in
                    ("succeeded", "failed", "interrupted", "running")},
        "cases": agent_cases,
    }
    ohos_summary = {
        "cases": len(ohos_cases),
        "completed": sum(item["status"] == "completed" for item in ohos_cases),
        "failed": sum(item["status"] in {"failed", "timed_out", "rate_limited", "interrupted"}
                      for item in ohos_cases),
        "devices": len(devices),
        **{key: sum(item[key] for item in devices) for key in
           ("testsRun", "passes", "failures", "errors", "ignored")},
        "caseResults": ohos_cases,
    }
    skipped = _list(summary.get("skipped"))
    return {
        "schemaVersion": "autorun-batch-report-v1", "batchId": _text(summary.get("batchId")),
        "status": _status(summary.get("status")), "generatedAt": payload["generatedAt"],
        "batch": {"executableCases": _number(summary.get("total")),
                  "completed": _number(summary.get("completed")),
                  "failed": _number(summary.get("failed")),
                  "skipped": len(skipped), "skippedCases": skipped},
        "agent": agent, "ohosTest": ohos_summary,
        "whitebox": whitebox_summary(results, _obj(summary.get("whiteboxEvaluation")).get("enabled")),
    }

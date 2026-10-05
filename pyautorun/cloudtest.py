"""Cloud-test configuration and result decisions for Python orchestration."""

import os
from pathlib import Path

from .batch_report import _numeric, _obj, _list, _truthy


def _fallback(*values):
    return next((value for value in values if _truthy(value)), values[-1])


def _text(value):
    if isinstance(value, bool):
        return str(value).lower()
    return str(value)


def _number(value, default=0):
    return _numeric(value) or default


def _field(source, key, default=""):
    return _text(_fallback(_obj(source).get(key), default)).strip()


def load_config(payload):
    config = _obj(payload.get("config"))
    raw = _obj(config.get("cloudTest"))
    base_dir = _fallback(config.get("__baseDir"), os.getcwd())
    default_cookie = Path(base_dir) / "agc-cookie.txt"
    cookie_file = str(default_cookie) if default_cookie.exists() else ""
    file_cookie = ""
    if cookie_file:
        file_cookie = default_cookie.read_text(encoding="utf-8").replace("\r", "").replace("\n", "").strip()

    categories = raw.get("testCategories")
    categories = categories if isinstance(categories, list) and categories else [{"category": 24, "timeSpan": 60}]
    test_categories = [{"category": _number(_obj(item).get("category"), 24),
                        "timeSpan": max(1, _number(_obj(item).get("timeSpan"), 60))}
                       for item in categories]
    server = _obj(config.get("server"))
    ohos_paths = _obj(_obj(config.get("ohosTest")).get("paths"))
    signing_configs = []
    for item in _list(raw.get("signingConfigs")):
        if not isinstance(item, dict):
            signing_configs.append(item)
            continue
        material = _obj(item.get("material")).copy()
        for key in ("storeFile", "profile", "certpath"):
            value = _field(material, key)
            if value and not os.path.isabs(value):
                material[key] = os.path.abspath(os.path.join(base_dir, value))
        signing_configs.append({**item, "material": material})

    normalized = {
        "enabled": raw.get("enabled") is not False,
        "cookieFile": cookie_file,
        "teamId": _text(_fallback(raw.get("teamId"), os.environ.get("AGC_TEAM_ID"), "")).strip(),
        "projectId": _text(_fallback(raw.get("projectId"), os.environ.get("AGC_PROJECT_ID"), "")).strip(),
        "agcAuthInfo": _text(_fallback(file_cookie, os.environ.get("AGC_AUTH_INFO"), "")).strip(),
        "paths": {
            "hvigorw": _text(_fallback(server.get("hvigorw"), ohos_paths.get("hvigorw"), "hvigorw")).strip(),
            "ohpm": _text(_fallback(server.get("ohpm"), ohos_paths.get("ohpm"), "ohpm")).strip(),
            "sdkHome": _field(server, "sdkHome"),
            "javaHome": _field(server, "javaHome"),
        },
        "product": _text(_fallback(raw.get("product"), "default")),
        "buildMode": _text(_fallback(raw.get("buildMode"), "release")),
        "buildTimeoutSec": max(60, _number(raw.get("buildTimeoutSec"), 1800)),
        "analyzeTimeoutSec": max(30, _number(raw.get("analyzeTimeoutSec"), 900)),
        "testCategories": test_categories,
        "appClass": _text(_fallback(raw.get("appClass"), "Tool")),
        "bundleName": _field(raw, "bundleName"),
        "signingConfigs": signing_configs,
        "taskType": _number(raw.get("taskType"), 28),
        "testItem": _text(_fallback(raw.get("testItem"), "17179869185")),
        "pollIntervalSec": max(5, _number(raw.get("pollIntervalSec"), 60)),
        "taskTimeoutSec": max(60, _number(raw.get("taskTimeoutSec"), 7200)),
        "proxy": _text(_fallback(raw.get("proxy"), os.environ.get("AGC_PROXY"), "")).strip(),
    }
    missing = [key for key in ("teamId", "projectId", "agcAuthInfo") if not normalized[key]]
    if missing:
        raise ValueError("cloudTest 配置不完整，缺少: " + ", ".join(missing)
                         + "（请在 config 中补齐或设置环境变量 AGC_TEAM_ID / AGC_PROJECT_ID / AGC_AUTH_INFO）")
    return normalized


def rank_devices(device_list):
    def key(raw_device):
        device = _obj(raw_device)
        idle = _number(device.get("idleDeviceCount"))
        usable = _number(device.get("usableNumber"))
        group = 0 if idle > 0 else 1 if usable > 0 else 2
        return (group, _number(device.get("waitTime")), -idle, -usable)

    return sorted(_list(device_list), key=key)


def final_status(task_group):
    group = _obj(task_group)
    status = _numeric(group.get("status")) if "status" in group else None
    result = _numeric(group.get("resultStatus")) if "resultStatus" in group else None
    if status in (3, 4, 5, 6) or result is not None and result > 0:
        return {"status": "completed", "error": ""}
    status_text = "NaN" if status is None else str(int(status) if float(status).is_integer() else status)
    result_text = ("undefined" if "resultStatus" not in group else
                   "null" if group["resultStatus"] is None else _text(group["resultStatus"]))
    return {"status": "failed", "error": f"任务组最终状态={status_text}（resultStatus={result_text}）"}


def summarize_report(report):
    report = _obj(report)
    task_list = _list(report.get("taskList"))
    categories = _list(_obj(report.get("overview")).get("categoryResults"))
    first = _obj(categories[0]) if categories else {}
    rules = _obj(first.get("ruleInfo"))
    return {
        "deviceCount": len(task_list),
        "devicePassed": sum(_numeric(_obj(task).get("resultStatus")) == 1 for task in task_list),
        "deviceFailed": sum(_numeric(_obj(task).get("resultStatus")) == 2 for task in task_list),
        "rulePassed": _number(rules.get("passedErrorCount")),
        "ruleFailed": _number(rules.get("failedErrorCount")),
        "issueCount": len(_list(report.get("problems"))),
    }

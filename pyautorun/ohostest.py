"""Normalize ohosTest Autorun settings and classify saved runner results."""

import os

from .batch_report import _numeric, _obj, _truthy


def _fallback(*values):
    return next((value for value in values if _truthy(value)), values[-1])


def _text(value):
    if isinstance(value, bool):
        return str(value).lower()
    return str(value)


def _js_text(value):
    if value is None:
        return "null"
    if isinstance(value, dict):
        return "[object Object]"
    if isinstance(value, list):
        return ",".join("" if item is None else _js_text(item) for item in value)
    return _text(value)


def normalize_config(payload):
    config = _obj(payload.get("config"))
    raw_value = config.get("ohosTest")
    has_config = isinstance(raw_value, dict)
    raw = raw_value if has_config else {}
    enabled = has_config and raw.get("enabled") is not False
    timeout = _numeric(raw.get("timeoutSec")) or 7200
    machine_config = {key: value for key, value in raw.items() if key not in ("enabled", "timeoutSec")}
    paths = machine_config.get("paths")
    if isinstance(paths, dict):
        paths = paths.copy()
        fold_script = _text(_fallback(paths.get("foldServerScript"), "")).strip()
        if fold_script and not os.path.isabs(fold_script):
            base_dir = _fallback(config.get("__baseDir"), os.getcwd())
            paths["foldServerScript"] = os.path.abspath(os.path.join(base_dir, fold_script))
        machine_config["paths"] = paths
    server = _obj(config.get("server"))
    sdk_home = _text(_fallback(server.get("sdkHome"), "")).strip()
    java_home = _text(_fallback(server.get("javaHome"), "")).strip()
    overrides = {}
    if sdk_home:
        overrides.update({key: sdk_home for key in ("DEVECO_SDK_HOME", "HOS_SDK_HOME", "OHOS_SDK_HOME")})
    if java_home:
        overrides["JAVA_HOME"] = java_home
    return {"enabled": enabled, "timeoutSec": max(1, timeout), "machineConfig": machine_config,
            "runnerEnvOverrides": overrides, "runMode": "swe"}


def classify_result(payload):
    runner_status = payload.get("runnerStatus")
    stop_reason = _text(_fallback(payload.get("stopReason"), ""))
    completed = runner_status == "completed"
    timed_out = "总运行时间超过" in stop_reason
    interrupted = "Autorun 中断" in stop_reason
    status = "completed" if completed else "timed_out" if timed_out else "interrupted" if interrupted else "failed"
    exit_code = _js_text(payload["exitCode"]) if "exitCode" in payload else "undefined"
    diagnostic = _fallback(payload.get("firstDiagnostic"), stop_reason,
                           f"ohostest:case 退出码 {exit_code}" if payload.get("exitCode") != 0
                           else f"ohostest:case 未在 {os.path.join(payload['inputDir'], '.ohostest-runs')} 生成 completed 结果")
    return {"status": status, "error": "" if completed else _js_text(diagnostic)}

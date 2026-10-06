"""Device-side ohosTest steps driven by the Python command executor."""

import json
import math
import re
import sys
from contextvars import ContextVar

TARGET_READY_MAX_ATTEMPTS = 120
UNLOCK_MAX_ATTEMPTS = 5
_HANDLER = ContextVar("ohostest_device_handler", default=None)


def _rpc(kind, **fields):
    handler = _HANDLER.get()
    if handler is not None:
        return handler(kind, **fields)
    sys.stdout.write(json.dumps({"type": kind, **fields}, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    reply_line = sys.stdin.readline()
    if not reply_line:
        raise RuntimeError("ohosTest device RPC disconnected")
    reply = json.loads(reply_line)
    if not reply.get("ok"):
        raise RuntimeError(reply.get("error") or "ohosTest device RPC failed")
    return reply.get("result")


def run_device_action(action, state, handler, artifacts=None):
    """Run an existing device operation directly with a Python command executor."""
    token = _HANDLER.set(handler)
    try:
        if action == "prepare":
            return prepare_device(state)
        if action == "install":
            return install_haps(state, artifacts or {})
        if action == "ready":
            return ensure_target_ready(state)
        if action == "disconnected":
            return wait_for_target_disconnected(state)
        if action == "test":
            return run_aa_test(state)
        raise ValueError(f"unknown device action: {action}")
    finally:
        _HANDLER.reset(token)


def shell_quote(value, platform, force=False):
    value = str(value)
    if not force and re.fullmatch(r"[A-Za-z0-9_./:=@+-]+", value):
        return value
    if platform == "win32":
        value = re.sub(r'(\\*)"', lambda match: match.group(1) * 2 + '\\"', value)
        value = re.sub(r"(\\+)$", lambda match: match.group(1) * 2, value)
        return f'"{value}"'
    return "'" + value.replace("'", "'\\''") + "'"


def is_target_connected(output, target):
    return any(line.strip().startswith(target) and not re.search(r"\bOffline\b", line, re.I)
               for line in re.split(r"\r?\n", output or ""))


def parse_screen_locked(result):
    if result.get("exitCode") != 0:
        return None
    match = re.search(r"\bscreenLocked\s*[:=]?\s*(true|false)\b",
                      (result.get("stdout") or "") + "\n" + (result.get("stderr") or ""), re.I)
    return match.group(1).lower() == "true" if match else None


def is_install_failure(result):
    if result.get("exitCode") != 0:
        return True
    output = (result.get("stdout") or "") + "\n" + (result.get("stderr") or "")
    return bool(re.search(r"msg:error:|error:\s*failed to install|failed to install the HAP or HSP", output, re.I))


def _command(command, poll=False):
    return _rpc("command", command=command, poll=poll)


def _sleep(ms):
    _rpc("sleep", ms=ms)


def _log_command(command, result):
    _rpc("logCommand", command=command, result=result)


def _log_error(message, error_code, command=None):
    _rpc("logError", message=message, errorCode=error_code, command=command)


def _target_command(state):
    return shell_quote(state["hdc"], state["platform"]) + " list targets"


def _hdc_for(state):
    return shell_quote(state["hdc"], state["platform"]) + " -t " + shell_quote(state["target"], state["platform"])


def ensure_target_ready(state):
    command = _target_command(state)
    last_result = None
    for _ in range(TARGET_READY_MAX_ATTEMPTS):
        result = _command(command, poll=True)
        last_result = result
        if is_target_connected(result.get("stdout") or "", state["target"]):
            _log_command(command, result)
            return None
        if state.get("startEmulator") and state.get("hideCommand"):
            try:
                _command(state["hideCommand"], poll=True)
            except Exception:
                pass
        _sleep(1000)
    if last_result is not None:
        _log_command(command, last_result)
    raise RuntimeError("hdc_not_connected")


def wait_for_target_disconnected(state):
    command = _target_command(state)
    last_result = None
    for _ in range(TARGET_READY_MAX_ATTEMPTS):
        result = _command(command, poll=True)
        last_result = result
        if not is_target_connected(result.get("stdout") or "", state["target"]):
            _log_command(command, result)
            return True
        _sleep(1000)
    if last_result is not None:
        _log_command(command, last_result)
    _log_error("hdc_disconnect_timeout", "HDC_DISCONNECT_TIMEOUT", command)
    return False


def prepare_device(state):
    hdc = _hdc_for(state)
    ensure_target_ready(state)
    device_type = _command(hdc + " shell param get const.product.devicetype")
    unlock_key = "2054" if device_type.get("exitCode") == 0 and (device_type.get("stdout") or "").strip().lower() == "2in1" else "Home"
    screen_lock_command = hdc + " shell hidumper -s ScreenlockService -a -all"
    for attempt in range(UNLOCK_MAX_ATTEMPTS):
        _command(hdc + " shell power-shell wakeup")
        _sleep(2500)
        key = unlock_key if attempt == 0 else "2054"
        _command(hdc + " shell uitest uiInput keyEvent " + key)
        _sleep(2000)
        locked = parse_screen_locked(_command(screen_lock_command))
        if locked is not True:
            return None
    raise RuntimeError("device_unlock_failed")


def _cleanup_stale_bundles(state, hdc):
    cleanup = state.get("bundleNameCleanup")
    if not cleanup:
        return
    try:
        listing = _command(hdc + " shell bm dump -a")
        if listing.get("exitCode") != 0:
            return
        names = [line.strip() for line in re.split(r"\r?\n", listing.get("stdout") or "") if line.strip()]
        seen = set()
        for name in names:
            if name in seen:
                continue
            seen.add(name)
            if any(name.startswith(prefix) for prefix in cleanup.get("prefixes", [])) and name not in cleanup.get("keep", []):
                _command(hdc + " uninstall " + shell_quote(name, state["platform"]))
    except Exception as exc:
        _log_error(str(exc), "BUNDLE_NAME_CLEANUP_FAILED")


def _install(state, hdc, paths):
    packages = " ".join(shell_quote(artifact, state["platform"]) for artifact in paths)
    if is_install_failure(_command(hdc + " install -r " + packages)):
        raise RuntimeError("install_failed")


def install_haps(state, artifacts):
    hdc = _hdc_for(state)
    _command(hdc + " uninstall " + shell_quote(state["bundleName"], state["platform"]))
    _cleanup_stale_bundles(state, hdc)
    for hsp in artifacts.get("hspPaths", []):
        _install(state, hdc, [hsp])
    _install(state, hdc, [artifacts["appHap"], artifacts["testHap"]])
    return None


def build_aa_test_command(input_value):
    quote = lambda value: shell_quote(value, input_value.get("platform", "linux"))
    parts = [quote(input_value["hdc"]), "-t", quote(input_value["target"]),
             "shell aa test", "-b", quote(input_value["bundleName"]),
             "-m", quote(input_value["testModule"]), "-s unittest", quote(input_value["testRunner"])]
    if input_value.get("testClass"):
        parts.extend(["-s class", quote(input_value["testClass"])])
    case_timeout = input_value.get("testCaseTimeoutMs")
    parts.extend(["-s timeout", str(15000 if case_timeout is None else case_timeout),
                  "-w", str(input_value["timeoutMs"])])
    return " ".join(parts)


def _status_value(record, key):
    prefix = "OHOS_REPORT_STATUS: " + key + "="
    lines = re.split(r"\r?\n", record)
    start = next((index for index, line in enumerate(lines) if line.startswith(prefix)), -1)
    if start < 0:
        return None
    values = [lines[start][len(prefix):]]
    for line in lines[start + 1:]:
        if re.match(r"^OHOS_REPORT_(?:STATUS|STATUS_CODE|RESULT|CODE):", line):
            break
        values.append(line)
    value = "\n".join(values).strip()
    return value or None


def parse_aa_test_output(output):
    cases = {}
    for record in re.split(r"(?=^OHOS_REPORT_STATUS:\s+class=)", output, flags=re.M):
        name = _status_value(record, "test")
        code_match = re.search(r"^OHOS_REPORT_STATUS_CODE:\s*(-?\d+)$", record, re.M)
        if not name or not code_match:
            continue
        code = int(code_match.group(1))
        status = "passed" if code == 0 else "ignored" if code == -3 else "running" if code == 1 else "failed"
        case = {"name": name, "status": status, "statusCode": code}
        duration = _status_value(record, "consuming")
        if duration:
            try:
                numeric_duration = float(duration)
                if math.isfinite(numeric_duration):
                    case["durationMs"] = int(numeric_duration) if numeric_duration.is_integer() else numeric_duration
            except ValueError:
                pass
        message = _status_value(record, "stream")
        stack = _status_value(record, "stack")
        if message:
            case["message"] = message
        if stack:
            case["stack"] = stack
        cases[name] = case
    summary = re.search(r"Tests run:\s*(\d+),\s*Failure:\s*(\d+),\s*Error:\s*(\d+),\s*Pass:\s*(\d+),\s*Ignore:\s*(\d+)", output)
    if not summary:
        result = {"ok": False, "blockedReason": "test_output_unparseable"}
        if cases:
            result["testCases"] = list(cases.values())
        return result
    counts = [int(value) for value in summary.groups()]
    report_match = re.search(r"OHOS_REPORT_CODE:\s*(-?\d+)", output)
    report_code = int(report_match.group(1)) if report_match else None
    result = {"ok": counts[1] == 0 and counts[2] == 0 and (report_code or 0) == 0,
              "testsRun": counts[0], "failures": counts[1], "errors": counts[2],
              "passes": counts[3], "ignored": counts[4], "testCases": list(cases.values())}
    if report_code is not None:
        result["reportCode"] = report_code
    return result


def run_aa_test(state):
    command = state.get("command") or build_aa_test_command(state)
    command_result = _rpc("command", command=command,
                          timeoutMs=state["timeoutMs"] + state.get("hostTimeoutGraceMs", 30000))
    parsed = parse_aa_test_output((command_result.get("stdout") or "") + "\n" + (command_result.get("stderr") or ""))
    return {"command": command, "commandResult": command_result, "parsed": parsed}


def dispatch(action, payload):
    if action == "ohostest-device-screen-locked":
        return parse_screen_locked(payload["result"])
    if action == "ohostest-device-install-failure":
        return is_install_failure(payload["result"])
    if action == "ohostest-device-target-connected":
        return is_target_connected(payload["output"], payload["target"])
    if action == "ohostest-device-aa-command":
        return build_aa_test_command(payload["input"])
    if action == "ohostest-device-aa-parse":
        return parse_aa_test_output(payload["output"])
    raise ValueError(f"unknown device action: {action}")


def main():
    payload = json.loads(sys.stdin.readline())
    action = payload["action"]
    state = payload["state"]
    try:
        if action == "prepare":
            result = prepare_device(state)
        elif action == "install":
            result = install_haps(state, payload["artifacts"])
        elif action == "ready":
            result = ensure_target_ready(state)
        elif action == "disconnected":
            result = wait_for_target_disconnected(state)
        elif action == "test":
            result = run_aa_test(state)
        else:
            raise ValueError(f"unknown device action: {action}")
        sys.stdout.write(json.dumps({"type": "result", "result": result}) + "\n")
        sys.stdout.flush()
    except Exception as exc:
        sys.stdout.write(json.dumps({"type": "error", "message": str(exc)}, ensure_ascii=False) + "\n")
        sys.stdout.flush()
        sys.exit(1)


if __name__ == "__main__":
    main()

"""Python build, emulator and HDC execution for ohosTest."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

from pyautorun.orchestration.case_run import write_json
from pyautorun.devices.ohostest_device import build_aa_test_command, run_device_action, shell_quote
from pyautorun.devices.ohostest_web import WebForwarding
from pyautorun.devices.ohostest_fold import deploy_fold_trigger, start_fold_server


def _iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _platform():
    return "win32" if os.name == "nt" else "darwin" if sys.platform == "darwin" else "linux"


class CommandLog:
    def __init__(self, path, executor=None):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.executor = executor or self._execute

    def record(self, kind, **values):
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"timestamp": _iso(), "type": kind, **values}, ensure_ascii=False) + "\n")

    def _execute(self, command, cwd, timeout_ms=None, detached=False):
        started = time.monotonic()
        process = subprocess.Popen(command, cwd=cwd, shell=True, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL if detached else subprocess.PIPE,
                                   stderr=subprocess.DEVNULL if detached else subprocess.PIPE,
                                   start_new_session=(os.name != "nt"))
        if detached:
            return {"exitCode": 0, "stdout": "", "stderr": "", "durationMs": 0, "pid": process.pid}
        try:
            stdout, stderr = process.communicate(timeout=(timeout_ms / 1000) if timeout_ms else None)
            timed_out = False
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                process.kill()
            else:
                os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
            timed_out = True
        return {"exitCode": process.returncode, "stdout": stdout.decode("utf-8", errors="replace"),
                "stderr": stderr.decode("utf-8", errors="replace"),
                "durationMs": round((time.monotonic() - started) * 1000), "timedOut": timed_out}

    def run(self, command, cwd, timeout_ms=None, detached=False, poll=False):
        result = self.executor(command, cwd, timeout_ms, detached)
        if not poll:
            self.record("command", command=command, cwd=str(cwd), result=result)
        return result


def _build_commands(config):
    paths = config["paths"]
    project = config["project"]
    q = lambda value: shell_quote(value, _platform())
    hvigor = q(paths["hvigorw"])
    commands = [(f"{q(paths['ohpm'])} install", project),
                (f"{hvigor} clean --no-daemon", project),
                (f"{hvigor} --mode {config['build']['mode']} -p product={config['product']} "
                 f"{config['build']['appTask']} --analyze=normal --parallel --incremental --no-daemon", project),
                (f"{hvigor} --mode module -p module={config['module']}@ohosTest "
                 f"{config['build']['testTask']} --no-daemon --stacktrace", project)]
    if config["platform"] == "flutter":
        flutter = (str(Path(paths["flutter"]) / "bin" / ("flutter.bat" if os.name == "nt" else "flutter"))
                   if paths.get("flutter") else "flutter")
        return [(f"{q(flutter)} pub get", str(Path(project).parent)), *commands]
    if config["platform"] == "rn":
        npm = paths.get("npm") or "npm"
        root = str(Path(project).parent)
        codegen = (f"npx react-native codegen-harmony --cpp-output-path ./harmony/{config['module']}/src/main/cpp/generated"
                   f" --rnoh-module-path ./harmony/{config['module']}/oh_modules/@rnoh/react-native-openharmony")
        bundles = config.get("rnBundleCommands") or ["npx react-native bundle-harmony --dev"]
        return [(f"{q(npm)} install --force", root), commands[0], (codegen, root),
                *[(value, root) for value in bundles], commands[1],
                (f"{hvigor} --mode module -p product={config['product']} assembleHap --no-daemon", project),
                commands[-1]]
    return commands


def _hsp_paths(config):
    app = config["artifacts"]["appHap"]
    if app.endswith("-unsigned.hap"):
        suffix = "-unsigned.hsp"
    elif app.endswith("-signed.hap"):
        suffix = "-signed.hsp"
    else:
        raise ValueError(f"cannot determine HSP signature type from app HAP: {app}")
    paths = []
    for module in config["sharedModules"]:
        output = Path(module["outputDir"])
        candidates = sorted(output.glob("*" + suffix)) if output.is_dir() else []
        if len(candidates) != 1:
            raise ValueError(f"shared module {module['name']} expected exactly one {suffix} file in {output}; "
                             f"found {len(candidates)}")
        paths.append(str(candidates[0]))
    return paths


def run_build(config, log, skip_build=False):
    started = time.monotonic()
    diagnostics = []
    if not skip_build:
        for command, cwd in _build_commands(config):
            result = log.run(command, cwd)
            if result["exitCode"]:
                diagnostics.append(f"构建命令失败：{command}")
                if result["stderr"].strip():
                    diagnostics.append("[build stderr] " + "\n".join(result["stderr"].splitlines()[-15:]))
                return {"build": {"status": "blocked", **config["artifacts"],
                                  "durationMs": round((time.monotonic() - started) * 1000),
                                  "blockedReason": "build_failed"}, "diagnostics": diagnostics,
                        "installArtifacts": None}
    app = config["artifacts"]["appHap"]
    test = config["artifacts"]["testHap"]
    if not Path(app).is_file() or not Path(test).is_file():
        diagnostics.append(f"HAP 文件不存在：{app if not Path(app).is_file() else test}")
        return {"build": {"status": "blocked", **config["artifacts"],
                          "durationMs": round((time.monotonic() - started) * 1000),
                          "blockedReason": "hap_missing"}, "diagnostics": diagnostics,
                "installArtifacts": None}
    try:
        hsp = _hsp_paths(config)
    except Exception as error:
        diagnostics.append(f"HSP 产物解析失败：{error}")
        return {"build": {"status": "blocked", **config["artifacts"],
                          "durationMs": round((time.monotonic() - started) * 1000),
                          "blockedReason": "hap_missing"}, "diagnostics": diagnostics,
                "installArtifacts": None}
    return {"build": {"status": "passed", **config["artifacts"],
                      "durationMs": round((time.monotonic() - started) * 1000)},
            "diagnostics": diagnostics, "installArtifacts": {"appHap": app, "testHap": test, "hspPaths": hsp}}


def _start_emulator(config, device, log):
    if not device.get("startEmulator"):
        return
    profile = device.get("profile")
    if not profile:
        raise RuntimeError(f"device {device['id']} has no emulator profile")
    q = lambda value: shell_quote(value, _platform())
    args = f"-start {q(profile)} -instancePath {q(config['paths']['emulatorDeployedDir'])} "
    args += f"-bootMode {device.get('bootMode') or 'coldboot'}"
    if device.get("hdcPort") is not None:
        args += f" -hdcport {device['hdcPort']}"
    binary = config["paths"]["emulatorBin"]
    if _platform() == "darwin" and binary.endswith(".app"):
        command = f"open -j -a {q(binary)} --args {args}"
    elif _platform() == "win32":
        command = f'start "" /min {q(binary)} {args}'
    else:
        command = f"{q(binary)} {args}"
    result = log.run(command, tempfile.gettempdir(), detached=True)
    if result["exitCode"]:
        raise RuntimeError("emulator_start_failed")
    if _platform() in ("darwin", "win32"):
        query = "pgrep -l -x Emulator" if _platform() == "darwin" else "tasklist /fo csv /nh"
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            output = log.run(query, config["project"], poll=True)["stdout"]
            if ("Emulator" in output):
                return
            time.sleep(2)
        raise RuntimeError("emulator_start_failed")


def _stop_emulator(config, device, log):
    if not device.get("startEmulator"):
        return
    q = lambda value: shell_quote(value, _platform())
    command = (f"{q(config['paths']['emulatorBin'])} -stop {q(device['profile'])} "
               f"-instancePath {q(config['paths']['emulatorDeployedDir'])}")
    log.run(command, tempfile.gettempdir(), detached=True)


def _device_handler(config, device, log):
    def handler(kind, **fields):
        if kind == "command":
            return log.run(fields["command"], config["project"], fields.get("timeoutMs"),
                           poll=fields.get("poll", False))
        if kind == "sleep":
            time.sleep(fields.get("ms", 0) / 1000)
            return None
        if kind == "logCommand":
            log.record("command", command=fields.get("command"), result=fields.get("result"),
                       deviceId=device["id"])
            return None
        if kind == "logError":
            log.record("error", message=fields.get("message"), errorCode=fields.get("errorCode"),
                       command=fields.get("command"), deviceId=device["id"])
            return None
        raise RuntimeError(f"未知设备事件: {kind}")
    return handler


def _suite_result(suite, execution):
    raw = execution["commandResult"]
    parsed = execution["parsed"]
    if raw.get("timedOut"):
        raise RuntimeError("test_command_timed_out")
    if raw.get("exitCode") != 0:
        parsed = {"ok": False, "testsRun": 0, "failures": 0, "errors": 1,
                  "passes": 0, "ignored": 0, "testCases": []}
    return {"suiteClass": suite, "status": "passed" if parsed.get("ok") else "failed",
            "testsRun": parsed.get("testsRun") or 0, "failures": parsed.get("failures") or 0,
            "errors": parsed.get("errors") or 0, "passes": parsed.get("passes") or 0,
            "ignored": parsed.get("ignored") or 0, "reportCode": parsed.get("reportCode"),
            "ok": bool(parsed.get("ok")), "testCases": parsed.get("testCases") or []}


def run_device(config, device, artifacts, suites, log, keep_emulators=False, web_server_port=None):
    started = time.monotonic()
    base = {"id": device["id"], "target": device["target"], "profile": device.get("profile") or "",
            "log": str(log.path)}
    handler = _device_handler(config, device, log)
    forwarding = None
    fold_server = None
    outcome = None
    try:
        _start_emulator(config, device, log)
        state = {"hdc": config["paths"]["hdc"], "target": device["target"], "platform": _platform(),
                 "startEmulator": device.get("startEmulator", False), "timeoutMs": config["timeoutMs"],
                 "bundleName": config["bundleName"], "testModule": config["testModule"],
                 "testRunner": config["testRunner"], "testCaseTimeoutMs": config["testCaseTimeoutMs"]}
        if config.get("bundleNameCleanup"):
            state["bundleNameCleanup"] = config["bundleNameCleanup"]
        run_device_action("prepare", state, handler)
        if web_server_port is not None:
            forwarding = WebForwarding(config["paths"]["hdc"], device["target"], web_server_port,
                                       log, config["project"])
            forwarding.start()
        if device.get("foldControl"):
            script = config["paths"].get("foldServerScript") or str(Path(__file__).with_name("fold-server.py"))
            if not Path(script).is_file():
                raise RuntimeError(f"fold_server_start_failed: script not found: {script}")
            fold_server = start_fold_server(device, script, config["paths"]["hdc"], log)
            deploy_fold_trigger(config["project"], config["moduleSrcPath"], fold_server.device_port)
            q = lambda value: shell_quote(value, _platform())
            command = (f"{q(config['paths']['hvigorw'])} --mode module -p "
                       f"module={config['module']}@ohosTest {config['build']['testTask']} --no-daemon")
            rebuilt = log.run(command, config["project"])
            if rebuilt["exitCode"]:
                raise RuntimeError("fold_trigger_rebuild_failed")
        run_device_action("install", state, handler, artifacts)
        suite_results = []
        for suite in suites or ["ALL"]:
            command = build_aa_test_command({**state, "testClass": "" if suite == "ALL" else suite})
            result = run_device_action("test", {**state, "command": command}, handler)
            output = result["commandResult"].get("stdout", "") + "\n" + result["commandResult"].get("stderr", "")
            if re.search(r"10106102|device screen is locked|unlock screen failed|TestAbility onDestroy unexpectedly|Can not connect to AAMS", output, re.I):
                run_device_action("prepare", state, handler)
                time.sleep(2)
                result = run_device_action("test", {**state, "command": command}, handler)
            suite_result = _suite_result(suite, result)
            suite_results.append(suite_result)
            log.record("testSuite", deviceId=device["id"], suite=suite_result)
        counts = {key: sum(item[key] for item in suite_results) for key in
                  ("testsRun", "failures", "errors", "passes", "ignored")}
        outcome = {**base, "status": "passed" if all(item["status"] == "passed" for item in suite_results) else "failed",
                **counts, "suiteResults": suite_results,
                "durationMs": round((time.monotonic() - started) * 1000),
                **({"foldServerPort": fold_server.port} if fold_server else {})}
    except Exception as error:
        reason = str(error)
        log.record("error", deviceId=device["id"], message=reason)
        outcome = {**base, "status": "blocked", "blockedReason": reason, "testsRun": 0,
                "failures": 0, "errors": 0, "passes": 0, "ignored": 0, "suiteResults": [],
                "durationMs": round((time.monotonic() - started) * 1000)}
    finally:
        cleanup_errors = []
        if fold_server:
            try:
                cleanup = fold_server.stop()
                if not cleanup["ok"]:
                    cleanup_errors.extend(cleanup["diagnostics"])
            except Exception as error:
                cleanup_errors.append(str(error))
        if forwarding:
            try:
                forwarding.stop()
            except Exception as error:
                cleanup_errors.append(str(error))
        if not keep_emulators:
            try:
                _stop_emulator(config, device, log)
            except Exception as error:
                cleanup_errors.append(str(error))
        if cleanup_errors:
            reason = "; ".join(cleanup_errors)
            log.record("error", deviceId=device["id"], message=reason)
            outcome["status"] = "blocked"
            outcome["blockedReason"] = reason
    return outcome


def run_execution(config, selection, out_dir, log, skip_build=False, keep_emulators=False,
                  web_server_port=None):
    started = time.monotonic()
    started_at = _iso()
    if any(item.get("foldControl") for item in config["devices"] if item["id"] in selection["devices"]):
        deploy_fold_trigger(config["project"], config["moduleSrcPath"], 8765)
    outcome = run_build(config, log, skip_build)
    devices = []
    if outcome["installArtifacts"]:
        lookup = {item["id"]: item for item in config["devices"]}
        for device_id in selection["devices"]:
            device = lookup[device_id]
            suites = ([config["testClass"]] if config.get("testClass") else
                      [] if selection["runAllTests"] else
                      selection["deviceSuiteOverrides"].get(device_id) or device.get("testSuites") or [])
            devices.append(run_device(config, device, outcome["installArtifacts"], suites, log,
                                      keep_emulators, web_server_port))
    status = "completed" if devices and all(item["status"] == "passed" for item in devices) else "failed"
    return {"project": config["project"], "status": status, "startedAt": started_at,
            "finishedAt": _iso(), "durationMs": round((time.monotonic() - started) * 1000),
            "build": outcome["build"], "devices": devices, "diagnostics": outcome["diagnostics"]}

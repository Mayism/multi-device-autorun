"""Host tool and emulator-port checks used before running cases."""

import os
import re
import socket
import subprocess
import sys


DEVECO_CLI_COMMAND = "devecocli"
DEVECO_CLI_INSTALL_COMMAND = "npm install -g @deveco/deveco-cli@latest"


def _decode_output(data):
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("gb18030", errors="replace")


def detect_deveco_cli(timeout_sec=5, env=None):
    env = os.environ.copy() if env is None else env
    args = [DEVECO_CLI_COMMAND, "--version"]
    try:
        if sys.platform == "win32":
            shell = env.get("ComSpec") or env.get("COMSPEC") or "cmd.exe"
            result = subprocess.run([shell, "/d", "/s", "/c", "devecocli --version"],
                                    env=env, capture_output=True, timeout=timeout_sec)
        else:
            result = subprocess.run(args, env=env, capture_output=True, timeout=timeout_sec)
    except FileNotFoundError as error:
        return _cli_result(False, "", str(error), "not-found")
    except subprocess.TimeoutExpired:
        return _cli_result(False, "", f"版本检测超过 {round(timeout_sec * 1000)}ms", "timeout")
    except OSError as error:
        return _cli_result(False, "", str(error), "spawn-error")
    output = (_decode_output(result.stdout) + "\n" + _decode_output(result.stderr)).strip()
    version = next((line.strip() for line in output.splitlines() if line.strip()), "")
    if result.returncode == 0 and version:
        return _cli_result(True, version, "", "")
    error = output or ("命令执行成功但未返回版本" if result.returncode == 0 else f"退出码 {result.returncode}")
    if re.search(r"Invalid regular expression flags|EBADENGINE|Unsupported engine", error, re.I):
        failure = "runtime-incompatible"
    elif re.search(r"[\"']?devecocli[\"']?\s+(?:is not recognized|不是内部或外部命令)", error, re.I):
        failure = "not-found"
    else:
        failure = "command-failed"
    return _cli_result(False, "", error, failure)


def _cli_result(installed, version, error, failure_kind):
    return {"installed": installed, "command": DEVECO_CLI_COMMAND, "version": version,
            "error": error, "failureKind": failure_kind, "installCommand": DEVECO_CLI_INSTALL_COMMAND}


def format_deveco_cli_failure(cli, runtime=None):
    runtime = runtime or {}
    details = f"：{cli['error']}" if cli.get("error") else ""
    node = f"；固定的 Node：{runtime['nodePath']}" if runtime.get("nodePath") else ""
    required = f"（CLI 要求 {runtime['requiredNode']}）" if runtime.get("requiredNode") else ""
    kind = cli.get("failureKind")
    if kind == "not-found":
        return f"命令未找到{details}；确认 CLI 已安装并位于 Agent PATH。安装命令：{cli['installCommand']}"
    if kind == "runtime-incompatible":
        return f"devecocli 的 Node 运行时不兼容{details}{node}{required}；请为 CLI 配置满足要求的 Node，并检查启动日志中的 devecocli Node。"
    if kind == "timeout":
        return f"版本检测超时{details}{node}；请检查 CLI 启动是否卡住。"
    return f"CLI 启动或执行失败{details}{node}{required}；请检查真实错误和 Agent 工具环境。"


def can_bind_tcp_port(port, host="127.0.0.1"):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind((host, port))
            return True
    except OSError:
        return False


def check_configured_emulator_ports(machine_config, probe_port=can_bind_tcp_port,
                                    min_port=10000, max_port=16555):
    devices = (machine_config or {}).get("devices") or []
    devices = devices if isinstance(devices, list) else []
    active = [device for device in devices if isinstance(device, dict)
              and device.get("startEmulator") is True and isinstance(device.get("hdcPort"), int)
              and not isinstance(device.get("hdcPort"), bool)]
    reserved = {device["hdcPort"] for device in devices if isinstance(device, dict)
                and isinstance(device.get("hdcPort"), int) and not isinstance(device.get("hdcPort"), bool)}
    conflicts = []
    for device in active:
        port = device["hdcPort"]
        if probe_port(port, "127.0.0.1"):
            continue
        recommended = None
        count = max_port - min_port + 1
        for offset in range(1, count + 1):
            candidate = min_port + ((port - min_port + offset) % count)
            if candidate not in reserved and probe_port(candidate, "127.0.0.1"):
                recommended = candidate
                reserved.add(candidate)
                break
        conflicts.append({"id": str(device.get("id") or "unknown"), "profile": str(device.get("profile") or ""),
                          "port": port, "recommendedPort": recommended})
    return conflicts


def format_emulator_port_conflict(conflict):
    name = f"{conflict['id']}（{conflict['profile']}）" if conflict.get("profile") else conflict["id"]
    port = conflict["port"]
    recommended = conflict.get("recommendedPort")
    if not isinstance(recommended, int):
        return f"模拟器 {name}：HDC 端口 {port} 已被占用，未找到可推荐的空闲端口"
    return (f"模拟器 {name}：HDC 端口 {port} 已被占用；"
            f"推荐同时将 target 改为 127.0.0.1:{recommended}、hdcPort 改为 {recommended}")

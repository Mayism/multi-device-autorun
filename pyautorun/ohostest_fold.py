"""Manage fold-control server, trigger and HDC reverse forwarding in Python."""

from hashlib import sha256
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from urllib.request import build_opener, ProxyHandler
from uuid import uuid4

from .case_run import write_json
from .ohostest_device import shell_quote


def _platform():
    return "win32" if os.name == "nt" else "darwin" if sys.platform == "darwin" else "linux"


def deploy_fold_trigger(project, module_src_path, device_port):
    source = Path(__file__).with_name("FoldTrigger.ets")
    content = source.read_text(encoding="utf-8")
    content = content.replace("const FOLD_SERVER_PORT = 8765;", f"const FOLD_SERVER_PORT = {device_port};")
    destination = Path(project) / module_src_path / "src" / "ohosTest" / "ets" / "util" / "FoldTrigger.ets"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(content, encoding="utf-8")
    return destination


def _available(port):
    try:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False


def _health(port, token, timeout=10):
    opener = build_opener(ProxyHandler({}))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with opener.open(f"http://127.0.0.1:{port}/health", timeout=0.5) as response:
                if response.status == 200 and json.load(response).get("ownerToken") == token:
                    return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def _state_file(hdc, target):
    key = sha256((hdc + "\0" + target).encode()).hexdigest()[:24]
    root = Path(tempfile.gettempdir()) / "harmonyos-ohostest-runner" / "fold"
    root.mkdir(parents=True, exist_ok=True)
    return root / f"{key}.json"


def _base(hdc, target):
    return f"{shell_quote(hdc, _platform())} -t {shell_quote(target, _platform())}"


def _forward_active(log, hdc, target, device_port, host_port):
    result = log.run(_base(hdc, target) + " fport ls", tempfile.gettempdir())
    if result["exitCode"]:
        return False
    needle = f"tcp:{device_port} tcp:{host_port}"
    return needle in result["stdout"]


def _remove_forward(log, hdc, target, device_port, host_port):
    command = _base(hdc, target) + f" fport rm tcp:{device_port} tcp:{host_port}"
    log.run(command, tempfile.gettempdir())
    return not _forward_active(log, hdc, target, device_port, host_port)


def _kill_pid(pid):
    try:
        os.kill(int(pid), signal.SIGTERM)
    except ProcessLookupError:
        pass


class FoldServer:
    def __init__(self, process, port, device_port, token, state_file, hdc, target, log):
        self.process, self.port, self.device_port, self.token = process, port, device_port, token
        self.state_file, self.hdc, self.target, self.log = state_file, hdc, target, log
        self.stop_event = threading.Event()
        self.keeper = threading.Thread(target=self._keep_forward, daemon=True)
        self.keeper.start()

    def _keep_forward(self):
        while not self.stop_event.wait(5):
            if self.process.poll() is not None:
                return
            try:
                if _forward_active(self.log, self.hdc, self.target, self.device_port, self.port):
                    continue
                for attempt in range(3):
                    if self.stop_event.is_set():
                        return
                    result = self.log.run(_base(self.hdc, self.target) +
                                          f" rport tcp:{self.device_port} tcp:{self.port}", tempfile.gettempdir())
                    if result["exitCode"] == 0 and "OK" in result["stdout"] + result["stderr"]:
                        break
                    self.stop_event.wait(1)
            except Exception:
                pass

    def stop(self):
        self.stop_event.set()
        self.keeper.join(timeout=6)
        diagnostics = []
        try:
            if not _remove_forward(self.log, self.hdc, self.target, self.device_port, self.port):
                diagnostics.append("fold_forward_cleanup_failed")
        except Exception as error:
            diagnostics.append(f"fold_forward_cleanup_failed: {error}")
        if self.process.poll() is None:
            if os.name == "nt":
                subprocess.run(["taskkill", "/pid", str(self.process.pid), "/t", "/f"], capture_output=True)
            else:
                os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    self.process.kill()
                else:
                    os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait()
        if not _available(self.port):
            diagnostics.append("fold_server_port_release_failed")
        if not diagnostics:
            self.state_file.unlink(missing_ok=True)
        return {"ok": not diagnostics, "diagnostics": diagnostics}


def start_fold_server(device, script, hdc, log):
    target = device["target"]
    state_file = _state_file(hdc, target)
    if state_file.is_file():
        try:
            state = json.loads(state_file.read_text(encoding="utf-8"))
            if _health(state["port"], state["ownerToken"], 1):
                _kill_pid(state["pid"])
                for _ in range(50):
                    if _available(state["port"]):
                        break
                    time.sleep(0.1)
            elif not _available(state["port"]):
                raise RuntimeError("fold_cleanup_failed")
            if not _remove_forward(log, hdc, target, state["devicePort"], state["port"]):
                raise RuntimeError("fold_forward_cleanup_failed")
            state_file.unlink(missing_ok=True)
        except (OSError, ValueError, KeyError) as error:
            raise RuntimeError(f"fold_cleanup_failed: {error}") from error
    for port in range(8766, 8866):
        if not _available(port):
            continue
        token = uuid4().hex
        args = [sys.executable, str(script), "--profile", device.get("profile") or device["id"],
                "--port", str(port), "--target", target, "--forwarding", "external",
                "--owner-token", token]
        process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, start_new_session=(os.name != "nt"))
        if not _health(port, token, 10):
            _kill_pid(process.pid)
            process.wait(timeout=5)
            continue
        device_port = port - 1
        state = {"schemaVersion": 1, "pid": process.pid, "port": port, "devicePort": device_port,
                 "target": target, "ownerToken": token, "forwardTask": f"tcp:{device_port} tcp:{port}",
                 "createdAt": time.time()}
        write_json(state_file, state)
        result = log.run(_base(hdc, target) + f" rport tcp:{device_port} tcp:{port}", tempfile.gettempdir())
        if result["exitCode"] == 0 and "OK" in result["stdout"] + result["stderr"]:
            return FoldServer(process, port, device_port, token, state_file, hdc, target, log)
        _remove_forward(log, hdc, target, device_port, port)
        _kill_pid(process.pid)
        process.wait(timeout=5)
        state_file.unlink(missing_ok=True)
    raise RuntimeError("fold_server_port_unavailable")

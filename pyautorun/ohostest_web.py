"""H5 development service and HDC reverse-port ownership."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
from urllib.request import build_opener, ProxyHandler

from .ohostest_device import shell_quote


WEB_PORT = 5175
WEB_READY_URL = f"http://127.0.0.1:{WEB_PORT}/"


def _port_free(port):
    with socket.socket() as sock:
        try:
            sock.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _terminate(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/pid", str(process.pid), "/t", "/f"], capture_output=True)
    else:
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            process.kill()
        else:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()


@contextmanager
def web_service(project_dir, output_dir, phase, log):
    project = Path(project_dir)
    manifest = json.loads((project / "package.json").read_text(encoding="utf-8"))
    if not isinstance((manifest.get("scripts") or {}).get("dev"), str) or not manifest["scripts"]["dev"].strip():
        raise ValueError("web_dev_script_missing: package.json scripts.dev")
    if not _port_free(WEB_PORT):
        raise ValueError(f"web_port_in_use: {WEB_PORT}")
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not npm:
        raise ValueError("web_npm_not_found: npm is required for the H5 project")
    logs = Path(output_dir) / "web" / phase
    logs.mkdir(parents=True, exist_ok=True)
    cache = Path(output_dir) / "web" / "npm-cache"
    temporary = Path(output_dir) / "web" / "tmp"
    cache.mkdir(parents=True, exist_ok=True)
    temporary.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "npm_config_cache": str(cache), "npm_config_update_notifier": "false",
           "npm_config_audit": "false", "npm_config_fund": "false",
           "TEMP": str(temporary), "TMP": str(temporary), "TMPDIR": str(temporary)}
    install_mode = "ci" if any((project / filename).is_file() for filename in
                               ("package-lock.json", "npm-shrinkwrap.json")) else "install"
    install_args = [npm, install_mode, "--no-audit", "--no-fund"]
    if install_mode == "install":
        install_args.append("--package-lock=false")
    with (logs / "install.log").open("wb") as stream:
        completed = subprocess.run(install_args, cwd=project, env=env, stdout=stream, stderr=stream,
                                   timeout=600, check=False)
    log.record("command", command=" ".join(install_args), cwd=str(project),
               result={"exitCode": completed.returncode, "stdout": f"log: {logs / 'install.log'}", "stderr": ""})
    if completed.returncode:
        raise RuntimeError(f"web_install_failed: exit={completed.returncode}; see {logs / 'install.log'}")
    process = None
    try:
        with (logs / "dev.log").open("wb") as stream:
            process = subprocess.Popen([npm, "run", "dev"], cwd=project, env=env,
                                       stdin=subprocess.DEVNULL, stdout=stream, stderr=stream,
                                       start_new_session=(os.name != "nt"))
        opener = build_opener(ProxyHandler({}))
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f"web_dev_exited: code={process.returncode}; see {logs / 'dev.log'}")
            try:
                with opener.open(WEB_READY_URL, timeout=1) as response:
                    if 200 <= response.status < 500:
                        break
            except Exception:
                pass
            time.sleep(0.5)
        else:
            raise TimeoutError(f"web_startup_timeout: {WEB_READY_URL}")
        log.record("command", command="npm run dev", cwd=str(project),
                   result={"exitCode": 0, "stdout": f"log: {logs / 'dev.log'}", "stderr": ""})
        yield
        if process.poll() is not None:
            raise RuntimeError(f"web_dev_exited: code={process.returncode}")
    finally:
        if process:
            _terminate(process)
            log.record("command", command="stop owned web processes", cwd=str(project),
                       result={"exitCode": 0, "stdout": "", "stderr": ""})


class WebForwarding:
    def __init__(self, hdc, target, port, log, cwd):
        self.hdc, self.target, self.port = hdc, target, port
        self.log, self.cwd = log, cwd
        self.owned = False

    def _base(self):
        platform = "win32" if os.name == "nt" else "darwin" if sys.platform == "darwin" else "linux"
        return f"{shell_quote(self.hdc, platform)} -t {shell_quote(self.target, platform)}"

    def _run(self, command, code):
        result = self.log.run(command, self.cwd)
        output = (result["stdout"] + "\n" + result["stderr"]).strip()
        if result["exitCode"] or re.search(r"\[Fail\]", output, re.I):
            raise RuntimeError(f"{code}: target={self.target}, port={self.port}: {output}")
        return result

    def _destinations(self, code):
        output = self._run(self._base() + " fport ls", code)["stdout"]
        found = []
        for line in output.splitlines():
            match = re.match(r"^(?:(\S+)\s+)?(\S+)\s+(\S+)\s+\[Reverse\]$", line.strip(), re.I)
            if match and (not match.group(1) or match.group(1) == self.target) and match.group(2) == f"tcp:{self.port}":
                found.append(match.group(3))
        return found

    def start(self):
        existing = self._destinations("web_forward_failed")
        if any(value != f"tcp:{self.port}" for value in existing):
            raise RuntimeError("web_forward_failed: device port has another mapping")
        if existing:
            return
        self._run(self._base() + f" rport tcp:{self.port} tcp:{self.port}", "web_forward_failed")
        self.owned = True
        if f"tcp:{self.port}" not in self._destinations("web_forward_failed"):
            raise RuntimeError("web_forward_failed: mapping was not established")

    def stop(self):
        if not self.owned:
            return
        existing = self._destinations("web_forward_cleanup_failed")
        if any(value != f"tcp:{self.port}" for value in existing):
            raise RuntimeError("web_forward_cleanup_failed: mapping changed; retained")
        if existing:
            self._run(self._base() + f" fport rm tcp:{self.port} tcp:{self.port}", "web_forward_cleanup_failed")
        self.owned = False

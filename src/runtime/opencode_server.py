"""Launch isolated OpenCode servers from Python."""

import asyncio
from copy import deepcopy
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from pyautorun.orchestration.agent import force_allow_everything
from pyautorun.orchestration.interaction import apply_agent_session_policy, AGENT_AUTO_APPROVAL_POLICY
from pyautorun.runtime.opencode import OpenCodeClient
from pyautorun.runtime.opencode_installation import resolve_opencode_source


def _now_id():
    return datetime.now().strftime("%Y%m%dT%H%M%S") + "-" + uuid4().hex[:6]


def _skill_names(root):
    names = set()
    if not root.is_dir():
        return []
    for skill_file in root.rglob("SKILL.md"):
        if not skill_file.is_file():
            continue
        text = skill_file.read_text(encoding="utf-8")
        if not text.startswith("---"):
            raise ValueError(f"Skill 缺少有效 name: {skill_file}")
        import re
        frontmatter = re.search(r"^---\r?\n([\s\S]*?)\r?\n---", text)
        name = re.search(r"^name:\s*[\"']?([^\"'\s]+)[\"']?\s*$", frontmatter.group(1), re.M) if frontmatter else None
        if not name:
            raise ValueError(f"Skill 缺少有效 name: {skill_file}")
        names.add(name.group(1))
    return sorted(names)


def _source_key(source_dir, assets_dir):
    first = str(source_dir).lower() if os.name == "nt" else str(source_dir)
    second = str(assets_dir).lower() if os.name == "nt" else str(assets_dir)
    return hashlib.sha256((first + "\0" + second).encode()).hexdigest()[:10]


def prepare_software_runtime(source, config, runtime_root, workspace, port, provider_overlay=""):
    """Copy source assets and return a private OpenCode environment plus Skill metadata."""
    runtime = Path(runtime_root)
    resources = Path(source["resourcesDir"])
    assets = Path(source["assetsDir"])
    effective = runtime / f"config-autorun-{_source_key(resources, assets)}"
    for name in ("data", "xdg-config", "state", "cache", "logs"):
        (runtime / name).mkdir(parents=True, exist_ok=True)
    effective.mkdir(parents=True, exist_ok=True)
    try:
        raw_config = json.loads((resources / "opencode.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError(f"无法解析 opencode.json: {error}") from error
    if provider_overlay:
        overlay = json.loads(Path(provider_overlay).read_text(encoding="utf-8"))
        if not isinstance(overlay.get("provider"), dict) or not overlay.get("providerId"):
            raise ValueError("无法加载 Provider 配置快照: 缺少 providerId/provider")
        raw_config["provider"] = {**(raw_config.get("provider") or {}), overlay["providerId"]: overlay["provider"]}
    agent = config["execution"].get("agent") or source.get("agent") or "build"
    raw_config = apply_agent_session_policy(raw_config, agent, AGENT_AUTO_APPROVAL_POLICY)
    allowed_skills = _skill_names(assets / "skills")
    raw_config["skills"] = {"paths": ["./skills"]}
    raw_config = force_allow_everything(raw_config, allowed_skills)
    # The Python monitor answers pending interactions; no project-owned JS permission plugin is loaded.
    raw_config["plugin"] = [item for item in (raw_config.get("plugin") or [])
                            if "opencode-auto-approve-plugin.mjs" not in str(item)]
    (effective / "opencode.json").write_text(json.dumps(raw_config, ensure_ascii=False, indent=2) + "\n",
                                                encoding="utf-8")
    for name in ("skills", "plugin", "provider"):
        src = assets / name
        dst = effective / name
        if dst.is_symlink() or dst.is_file():
            dst.unlink()
        elif dst.exists():
            shutil.rmtree(dst)
        if src.exists():
            shutil.copytree(src, dst, symlinks=False)
        else:
            dst.mkdir()
    snapshot_skills = _skill_names(effective / "skills")
    deveco_home = Path(config["server"].get("devecoHome") or
                       ("C:/Program Files/Huawei/DevEco Studio" if os.name == "nt" else
                        "/Applications/DevEco-Studio.app" if sys.platform == "darwin" else "/opt/deveco-studio"))
    if not deveco_home.exists():
        raise ValueError(f"DEVECO_HOME 不存在: {deveco_home}")
    contents = deveco_home / "Contents" if (deveco_home / "Contents").exists() else deveco_home
    java_home = Path(os.environ.get("JAVA_HOME") or (contents / ("jbr/Contents/Home" if sys.platform == "darwin" else "jbr")))
    sdk_home = Path(os.environ.get("DEVECO_SDK_HOME") or (contents / "sdk"))
    tool_home = Path(os.environ.get("TOOL_HOME") or contents)
    hos_home = Path(os.environ.get("HOS_SDK_HOME") or sdk_home)
    ohos_home = Path(os.environ.get("OHOS_SDK_HOME") or sdk_home)
    tool_paths = [contents / "tools" / "node" / "bin", contents / "tools" / "ohpm" / "bin",
                  contents / "tools" / "hvigor" / "bin", sdk_home / "default" / "openharmony" / "toolchains"]
    node = shutil.which("node")
    if node:
        tool_paths.insert(0, Path(node).parent)
    plugin_bin = effective / "plugin" / ".bin"
    if plugin_bin.exists():
        tool_paths.insert(0, plugin_bin)
    tool_paths.insert(0, java_home / "bin")
    env = os.environ.copy()
    for key in ("OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_AUTH_CONTENT", "OPENCODE_BUNDLED_CONFIG_DIR"):
        env.pop(key, None)
    run_id = _now_id()
    log_dir = runtime / "logs" / "runs" / run_id
    log_dir.mkdir(parents=True, exist_ok=True)
    env.update({"OPENCODE_CLIENT": "harmonybot-vscode", "OPENCODE_ENABLE_QUESTION_TOOL": "true",
                "XDG_DATA_HOME": str(runtime / "data"), "XDG_CONFIG_HOME": str(runtime / "xdg-config"),
                "XDG_STATE_HOME": str(runtime / "state"), "XDG_CACHE_HOME": str(runtime / "cache"),
                "OPENCODE_DB": "opencode-harmonybot.db", "OPENCODE_CONFIG_DIR": str(effective),
                "OPENCODE_DISABLE_PROJECT_CONFIG": "1", "OPENCODE_DISABLE_DEFAULT_PLUGINS": "1",
                "OPENCODE_DISABLE_AUTOUPDATE": "true", "JAVA_HOME": str(java_home),
                "PATH": os.pathsep.join([*(str(item) for item in tool_paths), os.environ.get("PATH", "")]),
                "TOOL_HOME": str(tool_home), "DEVECO_HOME": str(contents), "DEVECO_SDK_HOME": str(sdk_home),
                "HOS_SDK_HOME": str(hos_home), "OHOS_SDK_HOME": str(ohos_home),
                "HARMONYBOT_DEVECO_INSTALL_PATH": str(contents), "HARMONYBOT_LOG_ROOT": str(runtime / "logs"),
                "HARMONYBOT_IDE_HOST": "vscode", "HARMONYBOT_RUN_ID": run_id,
                "HARMONYBOT_IDE_LOG_DIR": str(log_dir), "HARMONYBOT_LOG_LEVEL": "info",
                "OPENCODE_RUN_ID": run_id, "OPENCODE_LOG_DIR": str(log_dir), "HM_PLUGIN_LOG_DIR": str(log_dir),
                "OPENCODE_DISABLE_EXTERNAL_SKILLS": "1", "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS": "1",
                "AUTORUN_SKILL_ALLOWLIST_JSON": json.dumps(allowed_skills)})
    tool_env = {key: env[key] for key in ("PATH", "JAVA_HOME", "TOOL_HOME", "DEVECO_HOME", "DEVECO_SDK_HOME",
                                          "HOS_SDK_HOME", "OHOS_SDK_HOME")}
    tool_read_roots = list(dict.fromkeys(str(path) for path in
                           [java_home, sdk_home, hos_home, ohos_home, contents / "tools" / "node",
                            contents / "tools" / "ohpm", contents / "tools" / "hvigor",
                            contents / "tools" / "emulator"]))
    return {"env": env, "configDir": str(effective), "logDir": str(log_dir),
            "toolResources": {"skillsRoot": str(effective / "skills"), "skillNames": snapshot_skills,
                              "env": tool_env, "toolReadRoots": tool_read_roots}}


def _port(url):
    parsed = urlsplit(url)
    return parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)


def _can_bind(url):
    host, port = _port(url)
    try:
        with socket.socket() as probe:
            probe.bind((host, port))
            return True
    except OSError:
        return False


def _choose_url(configured, max_attempts=20):
    parsed = urlsplit(configured)
    host, port = _port(configured)
    for offset in range(max_attempts):
        candidate = port + offset
        if candidate > 65535:
            break
        netloc = f"{host}:{candidate}"
        url = urlunsplit((parsed.scheme, netloc, parsed.path, parsed.query, parsed.fragment)).rstrip("/")
        if _can_bind(url):
            return url
    raise ValueError(f"OpenCode Server 端口不可用，已尝试 {port}-{min(65535, port + max_attempts - 1)}")


def _is_windows():
    return os.name == "nt"


def _terminate_windows_tree(process):
    # HarmonyBot's Node launcher spawns opencode.exe. TerminateProcess only stops
    # the launcher, leaving its child listening on the selected port.
    try:
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       capture_output=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        pass
    if process.poll() is None:
        process.terminate()


class OwnedServer:
    def __init__(self, client, config, source, process=None, log_path="", server_url="", tool_resources=None):
        self.client = client
        self.server_config = config
        self.source = source
        self.process = process
        self.log_path = log_path
        self.server_url = server_url
        self.tool_resources = tool_resources or {}
        self.owned = process is not None

    async def stop(self):
        if not self.process or self.process.poll() is not None:
            return
        if _is_windows():
            await asyncio.to_thread(_terminate_windows_tree, self.process)
        else:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        try:
            await asyncio.to_thread(self.process.wait, 5)
        except subprocess.TimeoutExpired:
            if _is_windows():
                self.process.kill()
            else:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            await asyncio.to_thread(self.process.wait)


async def _wait_for_config(client, process=None, timeout_sec=120):
    deadline = time.monotonic() + timeout_sec
    last_error = None
    while time.monotonic() < deadline:
        if process and process.poll() is not None:
            raise RuntimeError(f"OpenCode Server 启动后提前退出（code={process.returncode}）")
        try:
            return await client.get_config(min(60, max(1, int(deadline - time.monotonic()))))
        except Exception as error:
            last_error = error
            await asyncio.sleep(1)
    raise TimeoutError(f"OpenCode Server 配置加载超时（{timeout_sec} 秒）；最后一次错误: {last_error}")


async def start_server(config, workspace, reuse_existing=False, provider_overlay="", log=None):
    log = log or (lambda _message: None)
    source = resolve_opencode_source(config["server"]["opencodeSource"])
    configured = str(config["server"].get("url") or "").strip()
    if not configured:
        raise ValueError("未配置 server.url")
    client = OpenCodeClient(configured)
    if reuse_existing and await client.health():
        server_config = await _wait_for_config(client)
        return OwnedServer(client, server_config, source, server_url=configured)
    url = _choose_url(configured)
    client = OpenCodeClient(url)
    runtime_root = Path(config["server"]["runtimeRoot"])
    runtime_root.mkdir(parents=True, exist_ok=True)
    log_dir = runtime_root / "logs" / "runs" / (_now_id() + "-autorun-serve")
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "opencode-server.log"
    port = str(_port(url)[1])
    if source["mode"] == "softwareEngineering":
        prepared = prepare_software_runtime(source, config, runtime_root, workspace, port, provider_overlay)
        args = [source["opencodeBinPath"], "serve", "--port", port]
        env = prepared["env"]
        tool_resources = prepared["toolResources"]
    else:
        # HarmonyBot's launcher is distributed by the extension and remains an external tool.
        node = shutil.which("node")
        if not node:
            raise ValueError("HarmonyBot 插件启动器需要 Node，当前 PATH 未找到 node")
        args = [node, source["serverLauncherPath"], "--root", source["installation"]["extensionDir"],
                "--workspace", str(workspace), "--port", port]
        if config["server"].get("devecoHome"):
            args.extend(("--deveco-home", config["server"]["devecoHome"]))
        env = {**os.environ, "OPENCODE_DISABLE_EXTERNAL_SKILLS": "1",
               "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS": "1"}
        tool_resources = {"env": {"PATH": env.get("PATH", "")}, "toolReadRoots": []}
    with log_path.open("ab") as stream:
        process = subprocess.Popen(args, cwd=config["__baseDir"], env=env, stdin=subprocess.DEVNULL,
                                   stdout=stream, stderr=stream, start_new_session=(os.name != "nt"))
    log(f"[server] 正在启动 OpenCode Server: {url}")
    deadline = time.monotonic() + 120
    try:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f"OpenCode Server 启动后提前退出（code={process.returncode}），日志: {log_path}")
            if await client.health():
                break
            await asyncio.sleep(1)
        else:
            raise TimeoutError(f"OpenCode Server 健康检查超时，日志: {log_path}")
        server_config = await _wait_for_config(client, process)
        log(f"[server] OpenCode Server 已就绪: {url}")
        return OwnedServer(client, server_config, source, process, str(log_path), url, tool_resources)
    except Exception:
        server = OwnedServer(client, {}, source, process, str(log_path), url, tool_resources)
        await server.stop()
        raise

"""Discover OpenCode bundled with HarmonyBot or Software Engineering."""

import json
import os
from pathlib import Path
import platform
import re
import stat
import sys


HARMONY_EXTENSION_PREFIX = "huaweideveloperserviceplatform.harmonyosdevassistantforvscode"


def _node_platform():
    return {"Windows": "win32", "Darwin": "darwin"}.get(platform.system(), "linux")


def _node_arch():
    return {"x86_64": "x64", "AMD64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(
        platform.machine(), platform.machine())


def _version_key(value):
    core, _, prerelease = str(value or "0.0.0").partition("-")
    numbers = tuple(int(part) if part.isdigit() else 0 for part in core.split("."))
    natural = tuple((1, int(part)) if part.isdigit() else (0, part.lower())
                    for part in re.split(r"(\d+)", prerelease) if part)
    return numbers, not bool(prerelease), natural


def _safe_relative_path(value):
    normalized = str(value or "").replace("\\", "/")
    parts = [part for part in normalized.split("/") if part]
    if not normalized or normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized) or ".." in parts:
        return None
    return parts


def _bundled_opencode(resources_dir):
    metadata_path = resources_dir / "bundled-opencode.json"
    if metadata_path.exists():
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ValueError(f"bundled-opencode.json 无法解析: {error}") from error
        if metadata.get("platform") != _node_platform() or metadata.get("arch") != _node_arch():
            raise ValueError("OpenCode 二进制平台不匹配: "
                             f"Bundle={metadata.get('platform')}/{metadata.get('arch')}，"
                             f"当前={_node_platform()}/{_node_arch()}")
        segments = _safe_relative_path(metadata.get("exeRelativePath"))
        if not segments:
            raise ValueError("bundled-opencode.json 的 exeRelativePath 无效")
        executable = resources_dir.joinpath(*segments)
    else:
        executable = resources_dir / "bin" / _node_platform() / _node_arch() / (
            "opencode.exe" if sys.platform == "win32" else "opencode")
    if not executable.exists():
        raise ValueError(f"OpenCode 二进制不存在: {executable}")
    if sys.platform != "win32":
        mode = executable.stat().st_mode
        if not mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH):
            executable.chmod(mode | stat.S_IXUSR)
    return str(executable)


def _candidate(extension_dir):
    try:
        manifest = json.loads((extension_dir / "package.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if str(manifest.get("publisher", "")).lower() != "huaweideveloperserviceplatform":
        return None
    if str(manifest.get("name", "")).lower() != "harmonyosdevassistantforvscode":
        return None
    return {"extensionDir": str(extension_dir), "version": str(manifest.get("version") or "0.0.0")}


def find_harmony_extension(extensions_root):
    root = Path(os.path.abspath(str(extensions_root or "")))
    if not extensions_root or not root.exists():
        raise ValueError(f"VS Code 扩展目录不存在: {root}")
    direct = _candidate(root)
    candidates = [direct] if direct else [candidate for entry in root.iterdir()
                                          if entry.is_dir() and entry.name.lower().startswith(HARMONY_EXTENSION_PREFIX)
                                          if (candidate := _candidate(entry))]
    if not candidates:
        raise ValueError(f"未在 {root} 找到已安装扩展: {HARMONY_EXTENSION_PREFIX}-*")
    candidates.sort(key=lambda candidate: _version_key(candidate["version"]), reverse=True)
    failures = []
    for candidate in candidates:
        extension_dir = Path(candidate["extensionDir"])
        try:
            resources = extension_dir / "resources" / "opencode"
            binary = _bundled_opencode(resources)
            launcher = extension_dir / "tools" / "plugin-cli" / "run-opencode-serve.mjs"
            if not launcher.exists():
                raise ValueError(f"HarmonyBot 插件未提供 OpenCode 启动器: {launcher}")
            return {**candidate, "resourcesDir": str(resources), "bundledResourcesDir": str(resources),
                    "opencodeBinPath": binary, "serverLauncherPath": str(launcher)}
        except ValueError as error:
            failures.append(f"{extension_dir.name}: {error}")
    raise ValueError("已找到 HarmonyOS Dev Assistant 扩展，但 OpenCode Bundle 不可用：" + "；".join(failures))


def resolve_opencode_source(source):
    source = source or {}
    mode = str(source.get("mode") or "").strip()
    root = str(source.get("root") or "").strip()
    if mode not in ("harmonyBot", "softwareEngineering"):
        raise ValueError(f"server.opencodeSource.mode 仅支持 harmonyBot 或 softwareEngineering: {mode or '<empty>'}")
    if not root:
        raise ValueError(f"server.opencodeSource.root 不能为空（当前模式: {mode}）")
    root = os.path.abspath(root)
    if mode == "harmonyBot":
        installation = find_harmony_extension(root)
        return {"mode": mode, "root": root, "resourcesDir": installation["resourcesDir"],
                "assetsDir": "", "opencodeBinPath": installation["opencodeBinPath"],
                "serverLauncherPath": installation["serverLauncherPath"], "installation": installation}
    if not Path(root).exists():
        raise ValueError(f"softwareEngineering 资源根目录不存在: {root}")
    resources = Path(root) / "resources" / "opencode"
    missing = [name for name in ("opencode.json", "skills") if not (resources / name).exists()]
    if missing:
        raise ValueError(f"softwareEngineering 资源不完整: {resources}（缺少 {'、'.join(missing)}）")
    return {"mode": mode, "root": root, "resourcesDir": str(resources), "assetsDir": str(resources),
            "opencodeBinPath": _bundled_opencode(resources), "installation": None}

"""Inspect the actual OpenCode agent list, permissions and MCP configuration."""

import json
import subprocess
from copy import deepcopy
from pathlib import Path
from harmonyeval.utils.hashes import fingerprint
from harmonyeval.utils.security import redact


def inspect_runtime(prepared, agent, workspace):
    """Use a file for stdout: OpenCode's process.exit can truncate piped JSON."""
    path = Path(prepared["runtime"]) / "resolved.private.json"
    with path.open("w") as output:
        result = subprocess.run([prepared["binary"], "debug", "config"], cwd=workspace,
                                env=prepared["env"], stdout=output, stderr=subprocess.PIPE, timeout=120)
    path.chmod(0o600)
    if result.returncode:
        raise ValueError("OpenCode 配置加载失败；请检查 Plugin/Agent 入口及依赖")
    loaded = json.loads(path.read_text())
    registered = loaded.get("agent", {})
    import re
    agent_file = Path(prepared["runtime"]) / "agents.private.txt"
    with agent_file.open("w") as output:
        listed = subprocess.run([prepared["binary"], "agent", "list"], cwd=workspace,
                                env=prepared["env"], stdout=output, stderr=subprocess.PIPE, timeout=120)
    agent_file.chmod(0o600)
    available = re.findall(r"^([^\s].*?) \((?:primary|subagent|all)\)\s*$", agent_file.read_text(), re.M)
    if listed.returncode or not available:
        raise ValueError("无法解析实际 Agent 列表；当前 OpenCode CLI 接口不兼容")
    if agent not in available:
        raise ValueError(f"未注册 Agent: {agent}；可选: {', '.join(available)}")
    manifest = prepared["manifest"]
    version = subprocess.run([prepared["binary"], "--version"], env=prepared["env"],
                             capture_output=True, text=True, timeout=15)
    manifest["version"] = version.stdout.strip()
    manifest.update({"agents": sorted(registered), "plugin": redact(loaded.get("plugin", [])),
                     "available_agents": available,
                     "skill_paths": loaded.get("skills", {}).get("paths", []),
                     "mcp": redact(loaded.get("mcp", {})),
                     "agent_permissions": registered.get(agent, {}).get("permission", loaded.get("permission"))})
    for name in manifest.get("mcp_comparison_servers", []):
        expected = prepared["config"]["mcp"][name]["enabled"]
        actual = loaded.get("mcp", {}).get(name, {})
        if not isinstance(actual, dict) or actual.get("enabled", True) != expected:
            raise ValueError(f"OpenCode 实际 MCP 状态与 experiment 不符: {name}")
    if manifest.get("mcp_comparison_servers"):
        effective = deepcopy(loaded)
        for name in manifest["mcp_comparison_servers"]:
            effective["mcp"][name].pop("enabled", None)
        text = json.dumps(redact(effective), sort_keys=True).replace(str(prepared["runtime"]), "$RUNTIME")
        text = text.replace(str(workspace), "$WORKSPACE")
        manifest["mcp_comparison_effective_fingerprint"] = fingerprint(text)
    if manifest.get("without_enable"):
        if manifest.get("selected_plugins") or manifest.get("selected_skills"):
            raise ValueError("without 组发现被测能力残留")
        for name in manifest.get("disabled_names", []):
            if name in registered or any(name in str(p) for p in loaded.get("plugin", [])):
                raise ValueError(f"without组实际加载了被关闭的能力: {name}")
    return manifest

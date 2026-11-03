"""Locate OpenCode distributions and compose isolated target runtimes."""

import json
import os
import shutil
from harmonyeval.agent.environments.private import private_environment
from harmonyeval.agent.capabilities.loader import load_capabilities
from copy import deepcopy
from pathlib import Path
from harmonyeval.utils.json5 import read_loose_json5
from harmonyeval.api.registry import targets
from harmonyeval.utils.hashes import fingerprint
from harmonyeval.utils.security import redact
from harmonyeval.utils.io import write_json
from harmonyeval.agent.capabilities.config import merge, read_config, resolve_references


class OpenCodeTarget:
    version = "2"
    engine = "opencode"

    def source(self, task):
        execution = task["active"]["execution"]
        binary = execution["opencode"].get("binary") or shutil.which("opencode")
        root = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "opencode"
        if not binary or not Path(binary).is_file():
            raise ValueError("未找到独立 OpenCode；请配置 execution.opencode.binary")
        return {"binary": str(binary), "config_root": str(root), "distribution": "opencode"}

    def prepare(self, task, runtime):
        source = self.source(task)
        runtime = Path(runtime)
        config_root = runtime / "xdg-config" / "opencode"
        original = Path(source["config_root"])
        config_root.mkdir(parents=True, exist_ok=True)
        for name in ("package.json", "package-lock.json", "bun.lock", "bun.lockb"):
            if (original / name).is_file():
                shutil.copy2(original / name, config_root / name)
        # Preserve raw Agent/Plugin definitions rather than copying dynamically injected agents.
        for name in ("plugins", "plugin", "skills", "skill", "agents", "agent", "tools", "node_modules", "provider", "prompts", "formatters"):
            src = original / name
            if src.is_dir():
                shutil.copytree(src, config_root / name, symlinks=os.name != "nt")
        # Preserve package-relative imports of automatic symlink plugins.
        for path in config_root.rglob("*"):
            if path.is_symlink():
                source_path = original / path.relative_to(config_root)
                resolved = source_path.resolve()
                if original.resolve() in resolved.parents:
                    mapped = config_root / resolved.relative_to(original.resolve())
                    path.unlink()
                    path.symlink_to(mapped, target_is_directory=resolved.is_dir())
        config = read_config(original)
        execution = task["active"]["execution"]
        oc = execution["opencode"]
        if oc.get("config_path"):
            override_path = Path(oc["config_path"])
            override = read_loose_json5(override_path)
            # Resolve local references against the file that declared them.
            override = resolve_references(override, override_path.parent)
            config = merge(config, override)
        config = resolve_references(config, original, replacement=config_root)
        from harmonyeval.agent.capabilities.mcp import apply_mcp_overrides
        config = apply_mcp_overrides(config, task.get("experiment"))
        kind = task["target"]["type"]
        capability = load_capabilities(config, task, runtime, original, config_root)
        selected_plugins, selected_skills = capability['selected_plugins'], capability['selected_skills']
        loaded_plugins, loaded_skills = capability['loaded_plugins'], capability['loaded_skills']
        required_skills, disabled, bin_dir = capability['required_skills'], capability['disabled'], capability['bin_dir']
        # Override every configured model selection, including small-model/subagent requests.
        config.pop("small_model", None)
        for agent in config.get("agent", {}).values():
            if isinstance(agent, dict):
                agent.pop("model", None)
        config["provider"] = {}
        for key in ("model", "enabled_providers", "disabled_providers"):
            config.pop(key, None)
        env = private_environment(runtime, execution, bin_dir, config_root)
        config["permission"] = "allow"
        host = deepcopy(config)
        prefix = str(runtime / "capabilities")
        host["plugin"] = [p for p in host.get("plugin", []) if prefix not in str(p[0] if isinstance(p, list) else p)]
        host["skills"]["paths"] = [p for p in host["skills"].get("paths", []) if not p.startswith(prefix)]
        if task.get("scenario") == "KnowledgeEval" and kind in ("opencode_agent", "harmonybot_agent"):
            for mcp in host.get("mcp", {}).values():
                if isinstance(mcp, dict):
                    mcp.pop("enabled", None)
        host_text = json.dumps(redact(host), sort_keys=True).replace(str(runtime), "$RUNTIME")
        path = config_root / "opencode.json"
        write_json(path, config)
        path.chmod(0o600)
        manifest = {"engine": "opencode", "distribution": source["distribution"],
                    "binary": source["binary"], "agent": execution["agent_name"],
                    "without_enable": execution.get('without_enable', False),
                    "target_type": kind, "target_enabled": not disabled, "selected_plugins": loaded_plugins,
                    "selected_skills": loaded_skills, "required_skills": required_skills,
                    "disabled_names": [str(p.get("id") or p.get("package") or Path(p.get("source", "")).name)
                                       for p in selected_plugins] if disabled and kind == "plugin_agent" else
                                      [str(p.get("name") or Path(p.get("path") or task["target"].get("dir", "")).name)
                                       for p in selected_skills] if disabled and kind == "skills" else [],
                    "mcp": redact(config.get("mcp", {})), "config_fingerprint": fingerprint(redact(config))}
        manifest["host_config_fingerprint"] = fingerprint(host_text)
        if task.get("experiment", {}).get('overrides', {}).get('mcp'):
            controlled = sorted(task["experiment"]["overrides"]["mcp"])
            comparison = deepcopy(config)
            for name in controlled:
                comparison["mcp"][name].pop("enabled", None)
            comparison_text = json.dumps(redact(comparison), sort_keys=True).replace(str(runtime), "$RUNTIME")
            manifest["mcp_comparison_servers"] = controlled
            manifest["mcp_comparison_fingerprint"] = fingerprint(comparison_text)
        return {"binary": source["binary"], "config_path": str(path), "config": config,
                "env": env, "manifest": manifest, "runtime": str(runtime)}


@targets.register("opencode_agent")
class AgentTarget(OpenCodeTarget):
    pass


@targets.register("skills")
@targets.register("plugin_agent")
class CapabilityTarget(OpenCodeTarget):
    schema = {"type": "object", "required": ["type", "dir"]}


@targets.register("harmonybot_agent")
class HarmonyBotTarget(OpenCodeTarget):
    schema = {"type": "object", "required": ["type", "dir"]}

    def source(self, task):
        from harmonyeval.agent.opencode.opencode_installation import resolve_opencode_source
        resolved = resolve_opencode_source({"mode": "harmonyBot", "root": task["target"]["dir"]})
        root = Path(resolved["resourcesDir"])
        hash_file = root / ".bundle-hash"
        if hash_file.is_file():
            candidate = Path.home() / ".harmonybot/opencode-bundle/vscode" / hash_file.read_text().strip()
            if (candidate / ".bundle-complete").exists():
                root = candidate
        return {"binary": resolved["opencodeBinPath"], "config_root": str(root), "distribution": "harmonybot"}

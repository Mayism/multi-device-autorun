"""Resolve engines and compose private capability configurations."""

from copy import deepcopy
import json
import os
from pathlib import Path
import shutil
import subprocess

from pyautorun.devices.json5_lite import read_loose_json5
from pyautorun.harmony_eval.config import resolve
from pyautorun.harmony_eval.core import targets, fingerprint, redact, write_json, inside


def merge(first, second):
    result = deepcopy(first)
    for key, value in second.items():
        result[key] = merge(result[key], value) if isinstance(value, dict) and isinstance(result.get(key), dict) else deepcopy(value)
    return result


def read_config(root):
    result = {}
    for name in ("opencode.json", "opencode.jsonc"):
        path = Path(root) / name
        if path.is_file():
            result = merge(result, read_loose_json5(path))
    return result


def tool_environment(settings, base=None):
    env = dict(os.environ if base is None else base)
    paths = []
    mapping = {"deveco_home": "DEVECO_HOME", "flutter_home": "FLUTTER_HOME",
               "java_home": "JAVA_HOME", "sdk_home": "DEVECO_SDK_HOME"}
    for key, value in settings.items():
        if not value:
            continue
        path = Path(value)
        if not path.is_dir():
            raise ValueError(f"执行环境路径不存在: {key}={path}")
        if key in mapping:
            env[mapping[key]] = str(path)
        if key == "deveco_home":
            path = path / "Contents" if (path / "Contents").is_dir() else path
            env["DEVECO_HOME"] = str(path)
            for p in (path / "tools/node/bin", path / "tools/ohpm/bin", path / "tools/hvigor/bin"):
                paths.append(str(p))
            env.setdefault("JAVA_HOME", str(path / ("jbr/Contents/Home" if os.name != "nt" else "jbr")))
            env.setdefault("DEVECO_SDK_HOME", str(path / "sdk"))
        elif key in ("java_home", "flutter_home"):
            paths.append(str(path / "bin"))
        elif key == "sdk_home":
            paths.append(str(path / "default/openharmony/toolchains"))
    env["PATH"] = os.pathsep.join(paths + [env.get("PATH", "")])
    return env


class OpenCodeTarget:
    version = "1"
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
        kind = task["target"]["type"]
        selected_plugins, selected_skills = [], []
        if kind == "plugin_agent":
            target = task["target"]
            selected_plugins = [{"id": target.get("id") or Path(target["dir"]).name, "source": target["dir"],
                                 **{key: target[key] for key in ("entry", "options") if key in target}}]
        else:
            for entry in oc.get("plugins", []):
                item = dict(entry) if isinstance(entry, dict) else {"package": entry, "id": entry}
                item.setdefault("source", task["target"].get("dir"))
                selected_plugins.append(item)
        selected_skills = [dict(item) for item in oc.get("skills", [])]
        if kind == "skills" and not selected_skills:
            selected_skills = [{"path": task["target"]["dir"], "activation": "auto"}]
        disabled = execution.get("without_enable", False)
        bin_dir = runtime / "bin"
        bin_dir.mkdir(exist_ok=True)
        loaded_plugins = []
        for index, item in enumerate(selected_plugins):
            local = item.get("source")
            package = item.get("package")
            target_root = Path(resolve(task["base_dir"], local)) if local else None
            is_target = kind == "plugin_agent"
            if is_target:
                remove_owned(config, config_root, original, target_root, item)
            if is_target and disabled:
                continue
            if package:
                # Versions are part of the experiment identity.
                if "@" not in package.lstrip("@") or package.endswith(("@latest", "@*")):
                    raise ValueError("npm Plugin 必须指定固定版本，例如 package@1.2.3")
                plugin_path = package
            else:
                if not target_root or not target_root.exists():
                    raise ValueError(f"Plugin 源不存在: {target_root}")
                dst = runtime / "capabilities" / "plugins" / str(index)
                if target_root.is_dir():
                    shutil.copytree(target_root, dst, symlinks=False)
                    package_json = dst / "package.json"
                    pkg = json.loads(package_json.read_text()) if package_json.exists() else {}
                    entry = item.get("entry") or pkg.get("main") or "index.js"
                    entry_path = inside(dst, entry, exists=True)
                    bins = pkg.get("bin", {})
                    if isinstance(bins, str):
                        bins = {pkg.get("name", "plugin-cli").split("/")[-1]: bins}
                    for name, relative in bins.items():
                        cli = inside(dst, relative, exists=True)
                        cli.chmod(cli.stat().st_mode | 0o111)
                        shim = bin_dir / name
                        if os.name == "nt":
                            shim.with_suffix(".cmd").write_text(f'@node "{cli}" %*\n')
                        else:
                            shim.symlink_to(cli)
                else:
                    dst.mkdir(parents=True)
                    entry_path = dst / target_root.name
                    shutil.copy2(target_root, entry_path)
                plugin_path = entry_path.as_uri()
            config.setdefault("plugin", []).append([plugin_path, item["options"]] if "options" in item else plugin_path)
            loaded_plugins.append(item.get("id") or package or target_root.name)
        skill_paths = config.setdefault("skills", {}).setdefault("paths", [])
        loaded_skills, required_skills = [], []
        for index, item in enumerate(selected_skills):
            root = Path(resolve(task["base_dir"], item.get("path") or task["target"].get("dir", "")))
            candidates = [root / "SKILL.md"] if (root / "SKILL.md").exists() else list(root.glob("*/SKILL.md"))
            matches = []
            for skill_file in candidates:
                text = skill_file.read_text()
                import yaml
                meta = yaml.safe_load(text.split("---", 2)[1]) if text.startswith("---") else {}
                if not meta.get("name"):
                    raise ValueError(f"Skill 缺少 name: {skill_file}")
                if not item.get("name") or item["name"] == meta["name"]:
                    matches.append((meta["name"], skill_file.parent))
            if not matches:
                raise ValueError(f"找不到指定 Skill: {item.get('name') or root}")
            for name, folder in matches:
                if kind == "skills":
                    remove_owned(config, config_root, original, folder, {"id": name})
                    skill_paths = config["skills"]["paths"]
                if kind == "skills" and disabled:
                    continue
                dst = runtime / "capabilities" / "skills" / str(index) / name
                shutil.copytree(folder, dst, symlinks=False)
                # OpenCode skills.paths takes a parent containing skill directories.
                if str(dst.parent) not in skill_paths:
                    skill_paths.append(str(dst.parent))
                loaded_skills.append(name)
                if item.get("activation", "auto") == "required":
                    required_skills.append(name)
                elif item.get("activation", "auto") != "auto":
                    raise ValueError("Skill activation 只支持 auto/required")
        config["skills"]["paths"] = skill_paths
        config["plugin"] = list({json.dumps(p, sort_keys=True): p for p in config.get("plugin", [])}.values())
        if loaded_plugins or kind == "plugin_agent":
            config["subagent_depth"] = max(3, config.get("subagent_depth", 1))
        # Override every configured model selection, including small-model/subagent requests.
        config.pop("small_model", None)
        for agent in config.get("agent", {}).values():
            if isinstance(agent, dict):
                agent.pop("model", None)
        config["provider"] = {}
        for key in ("model", "enabled_providers", "disabled_providers"):
            config.pop(key, None)
        env = tool_environment(execution.get("enviroment", {}))
        for key in list(env):
            if key.startswith("OPENCODE_"):
                del env[key]
        for key, directory in (("XDG_CONFIG_HOME", "xdg-config"), ("XDG_DATA_HOME", "data"),
                               ("XDG_CACHE_HOME", "cache"), ("XDG_STATE_HOME", "state")):
            env[key] = str(runtime / directory)
            (runtime / directory).mkdir(exist_ok=True)
        env.update({"OPENCODE_CONFIG_DIR": str(config_root), "OPENCODE_DISABLE_PROJECT_CONFIG": "1",
                    "OPENCODE_DISABLE_DEFAULT_PLUGINS": "1", "OPENCODE_DISABLE_AUTOUPDATE": "true",
                    "OPENCODE_DISABLE_EXTERNAL_SKILLS": "1", "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS": "1",
                    "OPENCODE_DISABLE_MODELS_FETCH": "1",
                    "PATH": str(bin_dir) + os.pathsep + env.get("PATH", "")})
        # Global.Path.home otherwise discovers ~/.opencode even with project configs disabled.
        private_home = runtime / "home"
        private_home.mkdir(exist_ok=True)
        env["OPENCODE_TEST_HOME"] = str(private_home)
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
                    "without_enable": disabled, "selected_plugins": loaded_plugins,
                    "selected_skills": loaded_skills, "required_skills": required_skills,
                    "disabled_names": [str(p.get("id") or p.get("package") or Path(p.get("source", "")).name)
                                       for p in selected_plugins] if disabled and kind == "plugin_agent" else
                                      [str(p.get("name") or Path(p.get("path") or task["target"].get("dir", "")).name)
                                       for p in selected_skills] if disabled and kind == "skills" else [],
                    "mcp": redact(config.get("mcp", {})), "config_fingerprint": fingerprint(redact(config))}
        manifest["host_config_fingerprint"] = fingerprint(host_text)
        return {"binary": source["binary"], "config_path": str(path), "config": config,
                "env": env, "manifest": manifest, "runtime": str(runtime)}


def resolve_references(config, base, replacement=None):
    config = deepcopy(config)
    base = Path(base).resolve()
    def path_value(value):
        raw = str(value)
        prefix = "file://" if raw.startswith("file://") else ""
        if prefix:
            from urllib.request import url2pathname
            from urllib.parse import urlsplit
            parsed = urlsplit(raw)
            raw = url2pathname(("//" + parsed.netloc if parsed.netloc else "") + parsed.path)
        if not prefix and not raw.startswith((".", "/", "~")):
            return value
        path = Path(raw).expanduser()
        path = (base / path).resolve()
        if replacement and (path == base or base in path.parents):
            path = Path(replacement) / path.relative_to(base)
        return path.as_uri() if prefix or path.suffix in (".js", ".ts", ".mjs") else str(path)
    config["plugin"] = [[path_value(p[0]), *p[1:]] if isinstance(p, list) else path_value(p) for p in config.get("plugin", [])]
    skills = config.get("skills", {})
    if isinstance(skills, dict):
        skills["paths"] = [path_value(p) for p in skills.get("paths", [])]
    import re
    def file_references(value):
        if isinstance(value, dict):
            return {k: file_references(v) for k, v in value.items()}
        if isinstance(value, list):
            return [file_references(v) for v in value]
        if isinstance(value, str):
            return re.sub(r"\{file:([^}]+)\}", lambda m: "{file:" + str((base / m.group(1)).resolve()) + "}", value)
        return value
    return file_references(config)


def remove_owned(config, private, original, target_root, item):
    names = {str(item.get("id", "")), str(item.get("package", ""))}
    if target_root:
        names.add(target_root.name)
        pkg = target_root / "package.json"
        if pkg.is_file():
            names.add(json.loads(pkg.read_text()).get("name", ""))
    names.discard("")
    def owned(value):
        if isinstance(value, list):
            return owned(value[0])
        text = str(value)
        from urllib.parse import unquote
        normalized = unquote(text.removeprefix("file://"))
        parts = set(Path(normalized).parts)
        return (any(text == n or text.startswith(n + "@") or n in parts or Path(normalized).stem == n for n in names)
                or (target_root is not None and (normalized == str(target_root) or normalized.startswith(str(target_root) + os.sep))))
    config["plugin"] = [p for p in config.get("plugin", []) if not owned(p)]
    config.setdefault("skills", {})["paths"] = [p for p in config.get("skills", {}).get("paths", []) if not owned(p)]
    # Both the package directory and auto-discovered wrapper must be absent in without.
    for folder in ("plugins", "plugin", "skills", "skill"):
        root = private / folder
        if not root.is_dir():
            continue
        for path in list(root.iterdir()):
            source = original / folder / path.name
            if owned(path.name) or owned(source.resolve()):
                shutil.rmtree(path) if path.is_dir() else path.unlink()
    for name, definition in list(config.get("agent", {}).items()):
        if owned(name) or owned(definition.get("_managedBy", "")):
            del config["agent"][name]


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
        from pyautorun.runtime.opencode_installation import resolve_opencode_source
        resolved = resolve_opencode_source({"mode": "harmonyBot", "root": task["target"]["dir"]})
        root = Path(resolved["resourcesDir"])
        hash_file = root / ".bundle-hash"
        if hash_file.is_file():
            candidate = Path.home() / ".harmonybot/opencode-bundle/vscode" / hash_file.read_text().strip()
            if (candidate / ".bundle-complete").exists():
                root = candidate
        return {"binary": resolved["opencodeBinPath"], "config_root": str(root), "distribution": "harmonybot"}


@targets.register("knowledge")
@targets.register("http_agent")
class HttpTarget:
    version = "1"
    engine = "http"

    def source(self, task):
        return {"engine": "http", "url": task["active"]["execution"]["http_url"]}

    def prepare(self, task, runtime):
        return {"manifest": self.source(task)}


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
    if manifest.get("without_enable"):
        if manifest.get("selected_plugins") or manifest.get("selected_skills"):
            raise ValueError("without 组发现被测能力残留")
        for name in manifest.get("disabled_names", []):
            if name in registered or any(name in str(p) for p in loaded.get("plugin", [])):
                raise ValueError(f"without组实际加载了被关闭的能力: {name}")
    return manifest

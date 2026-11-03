"""Install selected Plugin and Skill capabilities into one private runtime."""
import json
import os
from pathlib import Path
import shutil
from harmonyeval.config.loader import resolve
from harmonyeval.utils.paths import inside
from harmonyeval.agent.capabilities.config import remove_owned


def _write_windows_shim(shim, cli, wrapper_name):
    # cmd.exe can read batch files using CP936. Keep their contents ASCII and
    # let Node pass the Unicode path to the real CLI without code-page conversion.
    wrapper = shim.parent / wrapper_name
    wrapper.write_text(
        'const {spawnSync} = require("node:child_process");\n'
        f'const cli = {json.dumps(str(cli), ensure_ascii=True)};\n'
        'const child = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {stdio: "inherit"});\n'
        'if (child.error) console.error(child.error.message);\n'
        'process.exit(child.status === null ? 1 : child.status);\n', encoding="utf-8")
    shim.with_suffix(".cmd").write_text(f'@node "%~dp0{wrapper_name}" %*\n', encoding="utf-8")


def load_capabilities(config, task, runtime, original, config_root):
    execution = task['active']['execution']
    oc = execution['opencode']
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
    # without_enable requests an additional group; only a resolved without child disables the target.
    disabled = not task.get('experiment', {}).get('overrides', {}).get('capability', {}).get('enabled', True)
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
                pkg = json.loads(package_json.read_text(encoding="utf-8")) if package_json.exists() else {}
                entry = item.get("entry") or pkg.get("main") or "index.js"
                entry_path = inside(dst, entry, exists=True)
                bins = pkg.get("bin", {})
                if isinstance(bins, str):
                    bins = {pkg.get("name", "plugin-cli").split("/")[-1]: bins}
                for bin_index, (name, relative) in enumerate(bins.items()):
                    cli = inside(dst, relative, exists=True)
                    cli.chmod(cli.stat().st_mode | 0o111)
                    shim = bin_dir / name
                    if os.name == "nt":
                        _write_windows_shim(shim, cli, f".plugin-cli-{index}-{bin_index}.cjs")
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
            text = skill_file.read_text(encoding="utf-8")
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
    return {
        'selected_plugins': selected_plugins, 'selected_skills': selected_skills,
        'loaded_plugins': loaded_plugins, 'loaded_skills': loaded_skills,
        'required_skills': required_skills, 'disabled': disabled, 'bin_dir': bin_dir,
    }

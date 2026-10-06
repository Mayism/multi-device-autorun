"""Discover and prepare skills from the selected OpenCode source."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit

from pyautorun.runtime.platform import detect_deveco_cli, format_deveco_cli_failure


ONE_MULTI_NAME = "harmonyos-ui-multi"
ONE_MULTI_INSTALLER = Path("scripts/install-to-project.py")
_FRONTMATTER = re.compile(r"^---\r?\n([\s\S]*?)\r?\n---")
_NAME = re.compile(r"^name:\s*[\"']?([^\r\n\"']+)[\"']?\s*$", re.M)


def _declared_name(skill_file):
    match = _FRONTMATTER.search(skill_file.read_text(encoding="utf-8"))
    if not match:
        return ""
    name = _NAME.search(match.group(1))
    return name.group(1).strip() if name else ""


def _registered_name(item):
    return str(item.get("name") or item.get("id") or "") if isinstance(item, dict) else str(item or "")


def _registered_location(item):
    value = str(item.get("location") or "").strip() if isinstance(item, dict) else ""
    if not value or (value.startswith("<") and value.endswith(">")):
        return None
    if value.startswith("file:"):
        return Path(unquote(urlsplit(value).path))
    return Path(os.path.abspath(value))


def _check_unique(skills, description):
    skills.sort(key=lambda item: item["name"])
    seen = set()
    for skill in skills:
        if skill["name"] in seen:
            raise ValueError(f"{description}: {skill['name']}")
        seen.add(skill["name"])
    return skills


def discover_runtime_skills(skills_root, registered_skills):
    root = Path(skills_root).resolve(strict=True)
    registered = {_registered_name(item): item for item in registered_skills}
    skills = []
    for current, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [name for name in dirs if not name.startswith(".") and name not in ("node_modules", "evals")]
        if "SKILL.md" not in files:
            continue
        skill_file = Path(current) / "SKILL.md"
        name = _declared_name(skill_file)
        if name not in registered:
            continue
        location = _registered_location(registered[name])
        if location and location.resolve(strict=True) != skill_file.resolve(strict=True):
            raise ValueError(f"已注册 Skill {name} 的路径不属于当前来源快照: {location}")
        skills.append({"name": name, "root": current})
    return _check_unique(skills, "来源中存在重复 Skill")


def discover_loaded_skills(registered_skills):
    skills = []
    for item in registered_skills if isinstance(registered_skills, list) else []:
        name = _registered_name(item).strip()
        location = _registered_location(item)
        if not name or not location:
            continue
        try:
            skill_file = location.resolve(strict=True)
        except FileNotFoundError:
            continue
        if skill_file.is_dir():
            skill_file = (skill_file / "SKILL.md").resolve(strict=True)
        elif not skill_file.is_file() or skill_file.name != "SKILL.md":
            continue
        if _declared_name(skill_file) != name:
            raise ValueError(f"OpenCode 注册 Skill {name} 的 location 与文件声明不一致: {skill_file}")
        skills.append({"name": name, "root": str(skill_file.parent)})
    return _check_unique(skills, "OpenCode 返回重复 Skill")


def _regular_path_inside(root, target):
    real_root = Path(root).resolve(strict=True)
    try:
        real_target = Path(target).resolve(strict=True)
    except FileNotFoundError:
        return None
    if real_root != real_target and real_root not in real_target.parents:
        raise ValueError(f"Skill 资源越出授权目录: {target}")
    return real_target


def prepare_agent_skill_runtime(resources, registered_skills, agent, source_mode):
    resources = resources or {}
    env = {**os.environ, **(resources.get("env") or {})}
    if not env.get("PATH"):
        raise ValueError("运行环境缺少 PATH，无法准备 Skill 工具")
    skills = (discover_runtime_skills(resources["skillsRoot"], registered_skills)
              if resources.get("skillsRoot") else discover_loaded_skills(registered_skills))
    runtime = {"skills": skills, "toolReadRoots": resources.get("toolReadRoots") or [], "env": env}
    if source_mode != "harmonyBot" or agent != "harmonyos-multi-device":
        return runtime
    one_multi = next((item for item in skills if item["name"] == ONE_MULTI_NAME), None)
    if one_multi is None:
        raise ValueError(f"{ONE_MULTI_NAME} 未出现在当前 OpenCode 已加载的 Skill 中")
    installer = _regular_path_inside(one_multi["root"], Path(one_multi["root"]) / ONE_MULTI_INSTALLER)
    if installer is not None and not installer.is_file():
        raise ValueError(f"Skill 安装入口不是文件: {installer}")
    cli = detect_deveco_cli(env=env)
    reported = {**cli, "error": str(cli.get("error") or "")[-2000:]}
    deveco_cli = ({"status": "available", "command": cli["command"], "version": cli["version"]}
                  if cli["installed"] else
                  {"status": "unavailable", "command": cli["command"], "failureKind": cli["failureKind"],
                   "error": reported["error"],
                   "warning": format_deveco_cli_failure(reported, resources.get("devecoCliRuntime"))})
    runtime["oneMulti"] = {"root": one_multi["root"], "installer": str(installer) if installer else None,
                           "devecoCli": deveco_cli}
    if installer:
        if sys.version_info < (3, 10):
            raise ValueError("harmonyos-ui-multi 需要 Python >= 3.10，请安装并加入 Agent 的 PATH")
        runtime["oneMulti"]["python"] = {"command": sys.executable, "args": []}
    if cli["installed"]:
        runtime["oneMulti"]["devecoCliVersion"] = cli["version"]
    if resources.get("devecoCliRuntime"):
        runtime["oneMulti"]["devecoCliRuntime"] = resources["devecoCliRuntime"]
    return runtime


def summarize_agent_skill_runtime(runtime):
    summary = {"skills": runtime["skills"], "toolReadRoots": runtime["toolReadRoots"]}
    if runtime.get("oneMulti"):
        summary["oneMulti"] = runtime["oneMulti"]
    return summary


def _reject_links(directory):
    for entry in directory.iterdir():
        if entry.is_symlink():
            raise ValueError(f".onemulti 不允许共享符号链接: {entry}")
        if entry.is_dir():
            _reject_links(entry)


def install_project_skill(runtime, project_dir):
    one_multi = runtime.get("oneMulti")
    if not one_multi or one_multi.get("installer") is None:
        return None
    project = Path(project_dir).resolve(strict=True)
    om_root = project / ".onemulti"
    if om_root.exists() or om_root.is_symlink():
        if om_root.is_symlink() or not om_root.is_dir():
            raise ValueError(".onemulti 必须是当前工程内的独立目录")
        _reject_links(om_root)
    ignore = project / ".gitignore"
    if ignore.is_symlink():
        raise ValueError("预装 Skill 时 .gitignore 不能是符号链接")
    original_ignore = ignore.read_bytes() if ignore.exists() else None
    python = one_multi["python"]
    env = {**runtime["env"], "PYTHONDONTWRITEBYTECODE": "1"}
    try:
        result = subprocess.run([python["command"], *python.get("args", []), "-B", one_multi["installer"], str(project)],
                                cwd=project, env=env, capture_output=True, text=True, timeout=60, check=True)
    finally:
        if original_ignore is None:
            ignore.unlink(missing_ok=True)
        else:
            ignore.write_bytes(original_ignore)
    if not om_root.is_dir() or om_root.is_symlink():
        raise ValueError(f"Skill 安装完成但未生成 {om_root}")
    _reject_links(om_root)
    return {"name": ONE_MULTI_NAME, "root": str(om_root), "sourceRoot": one_multi["root"],
            "output": result.stdout}


def inspect_skill_workflow(runtime, project_dir):
    one_multi = runtime.get("oneMulti")
    if not one_multi or one_multi.get("installer") is None:
        return None
    project = Path(project_dir)
    checks = []
    ledger = project / ".onemulti" / "decisions.json"
    try:
        if not ledger.is_file() or not ledger.stat().st_size:
            raise ValueError("文件为空或不是普通文件")
        json.loads(ledger.read_text(encoding="utf-8"))
        checks.append({"check": "decisions.json", "status": "passed"})
    except (OSError, UnicodeError, ValueError) as error:
        checks.append({"check": "decisions.json", "status": "missing-or-invalid", "error": str(error)[-4000:]})
    report = project / ".onemulti" / "adaptation-summary.html"
    checks.append({"check": "adaptation-summary.html",
                   "status": "passed" if report.is_file() and report.stat().st_size > 0 else "missing"})
    return {"status": "validated" if all(item["status"] == "passed" for item in checks) else "incomplete",
            "checks": checks}

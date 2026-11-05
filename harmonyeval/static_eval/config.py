"""Static assessment configuration and explicit Skill discovery."""

from importlib import metadata
from pathlib import Path

PACKAGES = {"quality": ("agent-extension-eval", "0.2.0"), "security": ("skill-security-scan", "1.2.3")}


def normalize(value, base, target):
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("static_eval 必须为对象")
    if not value:
        return {}
    value = dict(value)
    value.setdefault("enabled", True)
    if not isinstance(value["enabled"], bool):
        raise ValueError("static_eval.enabled 必须为布尔值")
    for key, default in (("timeout", 900), ("concurrency", 2)):
        value.setdefault(key, default)
        if type(value[key]) is not int or value[key] <= 0:
            raise ValueError(f"static_eval.{key} 必须为正整数")
    if value["concurrency"] > 16:
        raise ValueError("static_eval.concurrency 不得超过16")
    checks = value.setdefault("checks", ["quality", "security"])
    if not isinstance(checks, list) or not checks or any(c not in PACKAGES for c in checks) or len(checks) != len(set(checks)):
        raise ValueError("static_eval.checks 支持不重复的 quality/security")
    roots = value.get("skill_roots")
    if roots is None and target.get("type") in ("skills", "plugin_agent"):
        roots = [target["dir"]]
    if value["enabled"] and (not isinstance(value.get("model"), dict) or not roots):
        raise ValueError("启用 static_eval 需要 model 和 skill_roots（Agent目标请显式指定Skill范围）")
    if roots is not None:
        if not isinstance(roots, list) or not roots or any(not isinstance(p, str) or not p.strip() for p in roots):
            raise ValueError("static_eval.skill_roots 必须是非空路径数组")
        value["skill_roots"] = [str((Path(base) / Path(p).expanduser()).resolve()) for p in roots]
    return value


def discover_skills(config):
    paths = set()
    for value in config.get("skill_roots", []):
        root = Path(value)
        if not root.is_dir():
            raise ValueError(f"静态评估Skill目录不存在: {root}")
        if (root / "SKILL.md").is_file():
            paths.add(root.resolve())
        else:
            for manifest in root.rglob("SKILL.md"):
                if not any(p in (".git", "node_modules", ".venv", "venv") for p in manifest.relative_to(root).parts):
                    paths.add(manifest.parent.resolve())
    if not paths:
        raise ValueError("静态评估范围内未发现SKILL.md")
    return sorted(paths)


def plan(config):
    if not config.get("enabled", False):
        return {"enabled": False, "status": "disabled"}
    errors, versions = [], {}
    try:
        skills = [str(p) for p in discover_skills(config)]
    except ValueError as error:
        skills = []
        errors.append(str(error))
    for check in config["checks"]:
        package, expected = PACKAGES[check]
        try:
            installed = metadata.version(package)
            versions[package] = installed
            if installed != expected:
                errors.append(f"{package} 需要已验证版本 {expected}，当前为 {installed}")
        except metadata.PackageNotFoundError:
            errors.append(f"未安装 {package}=={expected}；请安装对应wheel")
    from harmonyeval.models.compatibility import resolve_api_key
    if not resolve_api_key(config["model"]):
        errors.append("静态评估模型密钥未设置，请检查 static_eval.model.api_key 对应的环境变量")
    return {"enabled": True, "status": "ready" if not errors else "unavailable",
            "skills": skills, "checks": config["checks"], "packages": versions, "errors": errors}

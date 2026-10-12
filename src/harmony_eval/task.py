"""Translate a HarmonyBot task.yaml into the existing Autorun execution contract."""

import json
import os
from pathlib import Path
import re
import shutil
import tempfile

import yaml

from pyautorun.orchestration.config import normalize_autorun_config
from pyautorun.harmony_eval.scoring import validate_scoring
from pyautorun.harmony_eval.verification import normalize_task_verifications
from pyautorun.runtime.opencode_installation import resolve_opencode_source


_AGENT_ALIASES = {"一多适配Agent": "harmonyos-multi-device"}
_OPENCODE_SERVER_URL = "http://127.0.0.1:61419"


def _mapping(value, field):
    if not isinstance(value, dict):
        raise ValueError(f"{field} 必须是 YAML 对象")
    return value


def _path(base, value, field):
    if not value or not isinstance(value, str):
        raise ValueError(f"{field} 必须是路径")
    path = Path(value).expanduser()
    return str((path if path.is_absolute() else base / path).resolve())


def _api_key(value):
    text = str(value or "").strip()
    if not text:
        raise ValueError("harmonybot_agent.execution.model.api_key 不能为空")
    if text.startswith("${") and text.endswith("}"):
        text = text[2:-1]
    if re.fullmatch(r"[A-Z][A-Z0-9_]*", text):
        resolved = os.environ.get(text)
        if not resolved:
            raise ValueError(f"模型 API Key 环境变量未设置: {text}")
        return resolved
    return text


def _bundle_config_dir(source):
    resources = Path(source["resourcesDir"])
    skills = resources / "skills"
    if skills.is_dir() and any(skills.iterdir()):
        return resources
    hash_file = resources / ".bundle-hash"
    if hash_file.is_file():
        bundle_hash = hash_file.read_text(encoding="utf-8").strip()
        cache = Path.home() / ".harmonybot" / "opencode-bundle" / "vscode" / bundle_hash
        if bundle_hash and (cache / ".bundle-complete").is_file():
            return cache
        raise ValueError(f"HarmonyBot Bundle 缓存未就绪: {cache}；请先启动 VS Code 扩展完成初始化")
    return resources


def _link_or_copy(source, destination):
    try:
        destination.symlink_to(source, target_is_directory=source.is_dir())
    except OSError:
        if source.is_dir():
            shutil.copytree(source, destination)
        else:
            shutil.copy2(source, destination)


def _stage_agent_source(source_root, output_root, model, without=False):
    """Create a private bundle so task model settings never modify the installed extension."""
    source = resolve_opencode_source({"mode": "harmonyBot", "root": source_root})
    extension = Path(source["installation"]["extensionDir"])
    bundle = _bundle_config_dir(source)
    parent = Path(output_root) / "_runtime" / "harmony-eval-sources"
    parent.mkdir(parents=True, exist_ok=True)
    staged = Path(tempfile.mkdtemp(prefix="source-", dir=parent))
    resources = staged / "resources" / "opencode"
    resources.mkdir(parents=True)
    (staged / "tools" / "plugin-cli").mkdir(parents=True)
    shutil.copy2(extension / "package.json", staged / "package.json")
    shutil.copy2(source["serverLauncherPath"], staged / "tools" / "plugin-cli" / "run-opencode-serve.mjs")
    for item in bundle.iterdir():
        if item.name in ("opencode.json", ".bundle-hash"):
            continue
        if without and item.name == "skills":
            continue
        _link_or_copy(item, resources / item.name)
    for item in Path(source["resourcesDir"]).iterdir():
        if item.name in ("opencode.json", ".bundle-hash") or (resources / item.name).exists():
            continue
        _link_or_copy(item, resources / item.name)
    if without:
        (resources / "skills").mkdir(exist_ok=True)
    raw = json.loads((bundle / "opencode.json").read_text(encoding="utf-8"))
    if model["base_url"]:
        provider_id = model["provider_id"]
        raw.setdefault("provider", {})[provider_id] = {
            "npm": "@ai-sdk/openai-compatible",
            "name": "Harmony Eval",
            "options": {"baseURL": model["base_url"], "apiKey": model["api_key"]},
            "models": {model["name"]: {"name": model["name"]}},
        }
    config_path = resources / "opencode.json"
    config_path.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    config_path.chmod(0o600)
    return str(staged)


def _verification(items, base):
    specs, legacy, shared = normalize_task_verifications(items, base)
    return {**legacy, **shared, "specs": specs}


def load_harmony_task(task_path):
    """Load a task and return normalized Autorun config plus task-level run settings."""
    path = Path(task_path).expanduser().resolve()
    try:
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as error:
        raise ValueError(f"无法读取 task.yaml: {path}: {error}") from error
    document = _mapping(document, "task.yaml")
    dataset = _mapping(document.get("dataset"), "dataset")
    if dataset.get("type") != "swe-bench-hm-multi-dev":
        raise ValueError("当前仅支持 dataset.type=swe-bench-hm-multi-dev")
    target = _mapping(document.get("target"), "target")
    task = _mapping(document.get("harmonybot_agent"), "harmonybot_agent")
    if "harmonybot_agent" not in str(target.get("type") or "").split("/"):
        raise ValueError("target.type 必须包含 harmonybot_agent")
    execution = _mapping(task.get("execution"), "harmonybot_agent.execution")
    model = _mapping(execution.get("model"), "harmonybot_agent.execution.model")
    model_name = str(model.get("name") or "").strip()
    base_url = str(model.get("base_url") or "").strip()
    if not model_name:
        raise ValueError("execution.model.name 不能为空")
    if bool(base_url) != bool(model.get("api_key")):
        raise ValueError("execution.model.base_url 和 api_key 必须同时配置，或都省略以使用已有 Provider")
    if model.get("api_type", "openai_api") != "openai_api":
        raise ValueError("当前仅支持 execution.model.api_type=openai_api")
    provider_id = str(model.get("provider_id") or ("harmony-eval" if base_url else "")).strip()
    if not provider_id:
        raise ValueError("使用已有模型配置时，execution.model.provider_id 不能为空")
    model_settings = {"name": model_name, "base_url": base_url,
                      "api_key": _api_key(model.get("api_key")) if base_url else "",
                      "provider_id": provider_id}
    report = _mapping(task.get("report"), "harmonybot_agent.report")
    if report.get("format", "html") != "html":
        raise ValueError("当前仅支持 harmonybot_agent.report.format=html")
    output_root = _path(path.parent, report.get("output_dir"), "report.output_dir")
    source_root = _path(path.parent, execution.get("agent_root") or target.get("dir") or
                        "~/.vscode/extensions", "execution.agent_root")
    without = execution.get("without_enable") is True
    verification = _verification(task.get("verification") or [], path.parent)
    scoring = task.get("scoring") or []
    scoring = validate_scoring(scoring, verification["specs"])
    staged_root = _stage_agent_source(source_root, output_root, model_settings, without=False)
    agent_name = str(execution.get("agent_name") or "harmonyos-multi-device").strip()
    agent_name = _AGENT_ALIASES.get(agent_name, agent_name)
    rounds = int(task.get("rounds") or 1)
    if rounds < 1:
        raise ValueError("harmonybot_agent.rounds 必须大于 0")
    timeout = int(execution.get("timeout") or 900)
    deveco_home = verification.get("devecoHome")
    java_home = Path(deveco_home) / "jbr" if deveco_home else None
    if java_home and (java_home / "Contents" / "Home").is_dir():
        java_home = java_home / "Contents" / "Home"
    raw_config = {
        "server": {"url": _OPENCODE_SERVER_URL,
                   "opencodeSource": {"id": "harmonybot", "mode": "harmonyBot",
                                      "root": staged_root, "agent": agent_name},
                   "devecoHome": deveco_home,
                   "sdkHome": str(Path(deveco_home) / "sdk") if deveco_home else "",
                   "javaHome": str(java_home) if java_home else "",
                   "hvigorw": str(Path(deveco_home) / "tools/hvigor/bin/hvigorw") if deveco_home else "",
                   "ohpm": str(Path(deveco_home) / "tools/ohpm/bin/ohpm") if deveco_home else ""},
        "execution": {"casesRoot": _path(path.parent, dataset.get("dir"), "dataset.dir"),
                      "outputRoot": output_root, "agent": agent_name,
                      "providerId": model_settings["provider_id"], "model": model_name,
                      "maxRuntimeSec": timeout, "idleTimeoutSec": min(timeout, 600),
                      "concurrency": int(execution.get("concurrency") or 1)},
        "ohosTest": verification["ohosTest"],
        "cloudTest": verification["cloudTest"],
        "whiteboxEvaluation": verification["whiteboxEvaluation"],
        "harmonyEval": {"taskId": str(document.get("id") or path.stem),
                        "verification": [spec.to_dict() for spec in verification["specs"]],
                        "scoring": scoring, "withoutEnable": without},
    }
    config = normalize_autorun_config(raw_config, path.parent, path)
    return config, rounds

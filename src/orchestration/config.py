"""Load the Autorun JSON configuration directly in Python."""

from copy import deepcopy
import json
import os
from pathlib import Path

from pyautorun.orchestration.agent import normalize_agent_targets, normalize_generation_model
from pyautorun.whitebox_eval.config import bind_runtime, normalize_config


DEFAULT_OUTPUT_ROOT = Path(__file__).resolve().parents[2] / "output"


def _resolve(base_dir, value):
    return os.path.abspath(os.path.join(str(base_dir), str(value))) if value else ""


def load_autorun_config(config_path="./config/autorun.config.json"):
    absolute_path = Path(os.path.abspath(config_path))
    if absolute_path.suffix.lower() != ".json":
        raise ValueError(f"Autorun 配置必须为 JSON 文件: {absolute_path}")
    try:
        raw = json.loads(absolute_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"配置文件不是合法 JSON: {absolute_path}: {error}") from error
    if not isinstance(raw, dict):
        raise ValueError(f"配置文件必须为 JSON 对象: {absolute_path}")
    base_dir = absolute_path.parent
    config = deepcopy(raw)
    config["__configPath"] = str(absolute_path)
    config["__baseDir"] = str(base_dir)
    server = config.setdefault("server", {})
    execution = config.setdefault("execution", {})
    target_config = normalize_agent_targets(server.get("opencodeSource"), base_dir)
    server["opencodeTargets"] = target_config
    server["opencodeSource"] = dict(target_config["targets"][0])
    execution["casesRoot"] = _resolve(base_dir, execution.get("casesRoot") or "./cases")
    execution["outputRoot"] = _resolve(base_dir, execution.get("outputRoot") or DEFAULT_OUTPUT_ROOT)
    server["runtimeRoot"] = _resolve(base_dir, server.get("runtimeRoot") or
                                      str(Path(execution["outputRoot"]) / "_runtime" / "opencode"))
    generation = normalize_generation_model(execution, require_provider=target_config["multiple"])
    execution["model"] = generation["modelId"]
    execution["providerId"] = generation["providerId"]
    execution["generationModel"] = generation
    whitebox = normalize_config({"raw": config.get("whiteboxEvaluation"),
                                 "outputRoot": execution["outputRoot"]})
    config["whiteboxEvaluation"] = bind_runtime({"config": whitebox,
                                                  "targets": target_config["targets"],
                                                  "baseDir": str(base_dir)})
    config["upload"] = {**(config.get("upload") or {}),
                        "enabled": (config.get("upload") or {}).get("enabled") is True}
    return config

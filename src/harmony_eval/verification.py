"""Registered verification plugins and their shared result contract."""

from dataclasses import dataclass, field
import importlib
from pathlib import Path
from typing import Any, Dict


VERIFIERS = {}


def register_verifier(*names):
    """Register a verifier under its canonical type and optional aliases."""
    def decorator(verifier_class):
        for name in names:
            key = name.lower()
            if key in VERIFIERS:
                raise ValueError(f"验证器重复注册: {name}")
            VERIFIERS[key] = verifier_class
        verifier_class.type_name = names[0]
        return verifier_class
    return decorator


def get_verifier(name):
    """Resolve a verifier type after loading the built-in plugins."""
    importlib.import_module("pyautorun.harmony_eval.verifiers")
    verifier = VERIFIERS.get(str(name).lower())
    if verifier is None:
        raise ValueError(f"未知验证器 {name!r}；可用类型: {', '.join(sorted(VERIFIERS))}")
    return verifier


@dataclass(frozen=True)
class VerificationSpec:
    """One configured verifier instance, independent of the evaluation scenario."""
    id: str
    type: str
    enabled: bool = True
    config: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self):
        return {"id": self.id, "type": self.type, "enabled": self.enabled, "config": self.config}


@dataclass(frozen=True)
class VerificationResult:
    """Stable envelope around a verifier's persisted raw report."""
    id: str
    type: str
    status: str
    report_path: str = ""
    error: str = ""
    details: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self):
        return {"id": self.id, "type": self.type, "status": self.status,
                "reportPath": self.report_path, "error": self.error, "details": self.details}


class Verifier:
    """A pluggable report producer used by every evaluation scenario."""
    type_name = ""
    legacy_config_key = ""
    legacy_result_key = ""
    affects_case_status = True
    requires_ohostest_case = False
    requires_cloud_stage = False
    retain_original = False

    def __init__(self, spec):
        self.spec = spec

    @classmethod
    def normalize_task_config(cls, item, base_dir, shared):
        """Translate verifier-specific YAML options into runtime settings."""
        return {key: value for key, value in item.items() if key not in ("id", "type", "enabled")}

    async def prepare(self, config, workspace, dependencies):
        """Prepare shared runtime resources before cases are scheduled."""
        return None

    async def verify(self, context):
        """Run one verifier and return its original outcome dictionary."""
        raise NotImplementedError

    def report_path(self, outcome):
        return str(outcome.get("resultPath") or "")

    def legacy_result(self, outcome):
        return outcome

    def should_run(self, agent_result):
        return agent_result.get("agentStatus") in ("completed", "timed_out")

    def result(self, outcome):
        outcome = outcome or {"status": "unavailable", "error": "验证器未返回结果"}
        return VerificationResult(id=self.spec.id, type=self.spec.type,
                                  status=str(outcome.get("status") or "failed"),
                                  report_path=self.report_path(outcome),
                                  error=str(outcome.get("error") or ""), details=outcome)


def normalize_task_verifications(items, base_dir):
    """Validate task entries through registered plugins and preserve legacy settings."""
    if not isinstance(items, list):
        raise ValueError("verification 必须是列表")
    importlib.import_module("pyautorun.harmony_eval.verifiers")
    shared = {}
    specs = []
    legacy = {}
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise ValueError(f"verification[{index}] 必须是对象")
        plugin_class = get_verifier(item.get("type"))
        if any(spec.type == plugin_class.type_name for spec in specs):
            raise ValueError(f"verification 类型重复: {plugin_class.type_name}")
        identifier = str(item.get("id") or plugin_class.type_name).strip()
        if not identifier or any(spec.id == identifier for spec in specs):
            raise ValueError(f"verification[{index}].id 为空或重复: {identifier}")
        settings = plugin_class.normalize_task_config(item, Path(base_dir), shared)
        spec = VerificationSpec(identifier, plugin_class.type_name, item.get("enabled") is not False, settings)
        specs.append(spec)
        if plugin_class.legacy_config_key:
            legacy[plugin_class.legacy_config_key] = {**settings, "enabled": spec.enabled}
    for plugin_class in set(VERIFIERS.values()):
        if plugin_class.legacy_config_key:
            legacy.setdefault(plugin_class.legacy_config_key, {"enabled": False})
    return specs, legacy, shared


def configured_verifications(config):
    """Read the common task contract or adapt a legacy JSON configuration."""
    configured = (config.get("harmonyEval") or {}).get("verification")
    if configured is not None:
        return [VerificationSpec(**item) for item in configured]
    importlib.import_module("pyautorun.harmony_eval.verifiers")
    specs = []
    for plugin_class in dict.fromkeys(VERIFIERS.values()):
        key = plugin_class.legacy_config_key
        settings = config.get(key) if key else None
        if isinstance(settings, dict) and settings.get("enabled") is True:
            specs.append(VerificationSpec(plugin_class.type_name, plugin_class.type_name, True, settings))
    return specs


async def prepare_verifiers(config, workspace, dependencies=None):
    """Instantiate active verifier plugins once for a run."""
    dependencies = dependencies or {}
    verifiers = []
    for spec in configured_verifications(config):
        if not spec.enabled:
            continue
        plugin = get_verifier(spec.type)(spec)
        await plugin.prepare(config, workspace, dependencies)
        verifiers.append(plugin)
    return verifiers

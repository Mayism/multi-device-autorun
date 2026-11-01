"""Shared contracts and small, independently extensible adapter registries."""

from dataclasses import asdict, dataclass, field
from importlib import metadata
import hashlib
import json
import math
from pathlib import Path
import re


PROJECT_DIRECTORY = "base"


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     default=str).encode()).hexdigest()


def file_fingerprint(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False,
                                    default=str) + "\n", encoding="utf-8")
    temporary.replace(path)


def redact(value, key=""):
    if re.search(r"authorization|token|secret|password|api.?key", key, re.I):
        return "[redacted]" if value else value
    if isinstance(value, dict):
        return {k: redact(v, str(k)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(v) for v in value]
    return value


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"需要有限数值，实际为 {value!r}")
    return float(value)


def safe_id(value):
    value = str(value)
    if not re.fullmatch(r"[\w.-]{1,160}", value) or value in (".", ".."):
        raise ValueError(f"非法标识: {value!r}")
    return value


def inside(root, value, *, exists=False):
    root = Path(root).resolve()
    path = (root / str(value)).resolve()
    if path != root and root not in path.parents:
        raise ValueError(f"路径超出根目录: {value}")
    if exists and not path.exists():
        raise ValueError(f"路径不存在: {path}")
    return path


class Registry:
    def __init__(self, group):
        self.group, self.items, self.loaded = group, {}, False

    def register(self, name):
        def decorate(cls):
            if name in self.items:
                raise ValueError(f"重复适配器: {self.group}/{name}")
            self.items[name] = cls
            return cls
        return decorate

    def get(self, name):
        if not self.loaded:
            self.loaded = True
            for entry in metadata.entry_points().select(group=f"harmony_eval.{self.group}"):
                self.register(entry.name)(entry.load())
        if name not in self.items:
            raise ValueError(f"未知 {self.group} 适配器 {name!r}；可选: {', '.join(self.items)}")
        return self.items[name]

    def validate(self, name, config):
        cls = self.get(name)
        schema = getattr(cls, "schema", None)
        if schema:
            from jsonschema import validate
            validate(config, schema)
        validate_config = getattr(cls, "validate", None)
        if validate_config:
            validate_config(config)
        return cls


datasets = Registry("datasets")
targets = Registry("targets")
executors = Registry("execution")
verifiers = Registry("verification")
scorers = Registry("scoring")


@dataclass
class EvalCase:
    case_id: str
    question: str
    root: str
    project: str = ""
    expected: dict = field(default_factory=dict)
    metadata: dict = field(default_factory=dict)

    def public(self):
        return {"case_id": self.case_id, "question": self.question}


@dataclass
class ExecutionResult:
    status: str
    answer: str = ""
    project: str = ""
    workspace: str = ""
    failure_category: str = ""
    error: str = ""
    elapsed_seconds: float = 0
    usage: dict = field(default_factory=dict)
    artifacts: dict = field(default_factory=dict)
    capabilities: dict = field(default_factory=dict)
    tool_calls: list = field(default_factory=list)

    def to_dict(self):
        return asdict(self)


@dataclass
class VerificationResult:
    verifier_id: str
    status: str
    metrics: dict = field(default_factory=dict)
    dimensions: list = field(default_factory=list)
    findings: list = field(default_factory=list)
    evidence: list = field(default_factory=list)
    error: str = ""
    version: str = "1"

    def to_dict(self):
        return asdict(self)


@dataclass
class ScoreResult:
    dimension: str
    status: str
    score: object = None
    max_score: float = 100
    breakdown: list = field(default_factory=list)
    error: str = ""
    version: str = "1"

    def to_dict(self):
        return asdict(self)

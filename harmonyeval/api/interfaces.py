"""Structural extension contracts; implementations may use inheritance or duck typing."""
from typing import Protocol
from .contracts import EvalCase, ExecutionResult, ScoreResult


class Workflow:
    version = "1"

    def requirements(self, config):
        return config.get("resources", [])


class DatasetLoader(Protocol):
    def load(self, config: dict) -> list[EvalCase]: ...
    def prepare(self, case: EvalCase, workspace) -> str: ...
    def fingerprint(self, case: EvalCase) -> str: ...
    def evidence_fingerprint(self, case: EvalCase) -> str: ...


class TargetAdapter(Protocol):
    engine: str
    def source(self, task: dict) -> dict: ...
    def prepare(self, task: dict, runtime) -> dict: ...


class ExecutionEngine(Protocol):
    async def execute(self, public_case: dict, target: dict, context: dict) -> ExecutionResult: ...


class ScoringRule(Protocol):
    def score(self, results: dict, config: dict) -> ScoreResult: ...

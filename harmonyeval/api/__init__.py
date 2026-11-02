"""Public result contracts and extension registries."""
from .contracts import PROJECT_DIRECTORY, EvalCase, ExecutionResult, VerificationResult, ScoreResult
from .registry import Registry, datasets, targets, executors, verifiers, scorers
from .interfaces import Workflow, DatasetLoader, TargetAdapter, ExecutionEngine, ScoringRule

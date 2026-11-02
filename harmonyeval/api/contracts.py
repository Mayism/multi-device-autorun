"""Typed case, execution, verification and scoring results."""

from dataclasses import asdict, dataclass, field


PROJECT_DIRECTORY = "base"


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

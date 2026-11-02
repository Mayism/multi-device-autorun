"""Register builtins lazily, keeping the public API free of concrete integrations."""
from importlib import import_module


BUILTINS = (
    "harmonyeval.benchmarks",
    "harmonyeval.agent.targets",
    "harmonyeval.agent.engines.http",
    "harmonyeval.agent.engines.opencode",
    "harmonyeval.verification.workflows.command",
    "harmonyeval.verification.workflows.library",
    "harmonyeval.verification.workflows.judge",
    "harmonyeval.verification.workflows.exact_match",
    "harmonyeval.verification.workflows.tool_usage",
    "harmonyeval.verification.workflows.uitest",
    "harmonyeval.verification.workflows.cloudtest",
    "harmonyeval.verification.workflows.skill",
    "harmonyeval.verification.workflows.composite",
    "harmonyeval.metrics.rules.boolean",
    "harmonyeval.metrics.rules.value",
    "harmonyeval.metrics.rules.weighted",
)


def register_builtins():
    for module in BUILTINS:
        import_module(module)

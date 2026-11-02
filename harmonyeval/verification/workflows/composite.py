"""Compose registered verification workflows as a dependency graph."""

from copy import deepcopy
from harmonyeval.config.loader import read_yaml
from harmonyeval.api.registry import verifiers
from harmonyeval.verification.base import Workflow, result
from harmonyeval.verification.pipeline import pipeline


@verifiers.register("Workflow")
class CompositeWorkflow(Workflow):
    """Compose registered workflows without adding a Python implementation."""
    @staticmethod
    def validate(config):
        if not config.get("steps") and not config.get("workflow_path"):
            raise ValueError("Workflow需要steps或workflow_path")

    async def verify(self, case, execution, dependencies, context, config):
        from harmonyeval.config.loader import flow_order
        from harmonyeval.metrics.sources import source_value
        settings = config if "steps" in config else read_yaml(config["workflow_path"])
        steps = deepcopy(settings["steps"])
        task = deepcopy(context["task"])
        depth = task.get("_workflow_depth", 0) + 1
        if depth > 16:
            raise ValueError("组合评估流程嵌套过深或循环引用")
        task["_workflow_depth"] = depth
        for step in steps:
            step.setdefault("id", step["type"])
            verifiers.validate(step["type"], step)
        task["active"]["verification"] = flow_order(steps)
        values = await pipeline(task, case, execution, context["output"], context.get("cancel_event"))
        mappings = settings.get("metrics", {})
        metrics = {name: source_value(values, source) for name, source in mappings.items()}
        return result(config, metrics=metrics, evidence=[{"workflows": values}])

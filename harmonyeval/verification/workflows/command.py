"""Adapt a declared acceptance command to a verification result."""

from harmonyeval.api.registry import verifiers
from harmonyeval.verification.base import Workflow, result
from harmonyeval.verification.context import command_run, isolated_project


@verifiers.register("Command")
class CommandWorkflow(Workflow):
    schema = {"type": "object", "required": ["command"],
              "properties": {"command": {"type": "array", "minItems": 1, "items": {"type": "string"}}}}

    async def verify(self, case, execution, dependencies, context, config):
        project = await isolated_project(execution, context)
        outcome = await command_run(config["command"], project, context, "command", config.get("timeout", 600))
        return result(config, metrics={"passed": outcome["exit_code"] == 0}, evidence=[outcome])

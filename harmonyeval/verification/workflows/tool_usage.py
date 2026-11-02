"""Observe configured MCP usage without assuming knowledge was used."""

from harmonyeval.api.registry import verifiers
from harmonyeval.verification.base import Workflow, result


@verifiers.register("ToolUsage")
class ToolUsage(Workflow):
    async def verify(self, case, execution, dependencies, context, config):
        mcp = config.get("target_mcp", "")
        server = execution.capabilities.get("mcp", {}).get(mcp)
        calls = [c for c in execution.tool_calls if str(c.get("name", "")).startswith(mcp + "_")]
        return result(config, metrics={"configured": server is not None,
                                      "enabled": server.get("enabled", True) if server else False,
                                      "attempted": len(calls), "succeeded": sum(c.get("status") == "completed" for c in calls)},
                      findings=["仅观测；工具未调用时不推断已使用知识，也不判为业务失败。"])

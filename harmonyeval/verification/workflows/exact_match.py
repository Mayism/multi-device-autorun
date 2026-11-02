"""Compare an answer against accepted reference strings."""

from harmonyeval.api.registry import verifiers
from harmonyeval.verification.base import Workflow, result


@verifiers.register("ExactMatch")
class ExactMatch(Workflow):
    async def verify(self, case, execution, dependencies, context, config):
        refs = case.expected.get("reference_answers", [])
        if not refs:
            return result(config, "unavailable", error="缺少reference_answers")
        passed = any(execution.answer.strip() == str(r).strip() for r in refs)
        return result(config, metrics={"passed": passed, "score": 100 if passed else 0})

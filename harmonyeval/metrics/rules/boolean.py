"""Score boolean acceptance conditions."""

from harmonyeval.api.registry import scorers
from harmonyeval.api.contracts import ScoreResult
from harmonyeval.utils.numbers import number
from harmonyeval.metrics.sources import source_value


@scorers.register("BooleanScoring")
class BooleanScoring:
    version = "1"
    schema = {"type": "object", "required": ["all"],
              "properties": {"all": {"type": "array", "minItems": 1,
                                     "items": {"type": "object", "required": ["source", "equals"]}}}}

    def score(self, results, config):
        details = [{"source": condition["source"], "actual": source_value(results, condition["source"]),
                    "expected": condition["equals"]} for condition in config["all"]]
        passed = all(item["actual"] == item["expected"] for item in details)
        score = number(config.get("pass_score", 100) if passed else config.get("fail_score", 0))
        return ScoreResult(config["dimension"], "scored", score,
                           number(config.get("pass_score", 100)), details)

"""Scale a verified numeric metric into a score."""

from harmonyeval.api.registry import scorers
from harmonyeval.api.contracts import ScoreResult
from harmonyeval.utils.numbers import number
from harmonyeval.metrics.sources import source_value


@scorers.register("ImmediateValue")
class ImmediateValue:
    version = "1"
    schema = {"type": "object", "required": ["source"]}

    def score(self, results, config):
        raw = number(source_value(results, config["source"]))
        score = raw * number(config.get("scale", 1))
        maximum = number(config.get("max_score", 100))
        if not 0 <= score <= maximum:
            raise ValueError(f"评分值超出 [0,{maximum}]: {score}")
        return ScoreResult(config["dimension"], "scored", score, maximum,
                           [{"source": config["source"], "raw": raw, "scale": config.get("scale", 1)}])

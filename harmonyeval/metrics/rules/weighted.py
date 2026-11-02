"""Combine weighted dimensions using proportional deductions."""

from harmonyeval.api.registry import scorers
from harmonyeval.api.contracts import ScoreResult
from harmonyeval.utils.numbers import number
from harmonyeval.metrics.sources import source_value


@scorers.register("WeightedSummation")
class WeightedSummation:
    version = "1"
    schema = {"type": "object", "required": ["components"],
              "properties": {"components": {"type": "array", "minItems": 1}}}

    @staticmethod
    def validate(config):
        weights = [number(c["weight"]) for c in config["components"]]
        if any(w < 0 for w in weights) or abs(sum(weights) - 1) > 1e-8:
            raise ValueError("components.weight 必须非负且合计为 1")
        if config.get("mode", "deduction") not in ("deduction", "sum"):
            raise ValueError("WeightedSummation.mode 支持 deduction/sum")

    def score(self, results, config):
        maximum = number(config.get("base_score", 100))
        deductions, breakdown = [], []
        for item in config["components"]:
            allocation = maximum * item["weight"]
            raw = source_value(results, item["source"])
            detail = {"name": item.get("name", item["source"]), "source": item["source"],
                      "weight": item["weight"], "allocation": allocation}
            if item.get("reducer") == "proportional_deduction":
                if not isinstance(raw, list) or not raw:
                    raise ValueError("白盒缺少维度评分")
                total_max = sum(number(d["max_score"]) for d in raw)
                if total_max <= 0:
                    raise ValueError("白盒维度满分合计必须大于 0")
                dimensions = []
                earned = 0
                for dimension in raw:
                    cap, score = number(dimension["max_score"]), number(dimension["score"])
                    if cap <= 0 or not 0 <= score <= cap:
                        raise ValueError("白盒维度得分越界")
                    assigned = allocation * cap / total_max
                    lost = assigned * (1 - score / cap)
                    earned += assigned - lost
                    dimensions.append({"name": dimension.get("name", dimension.get("dimension_name", "")),
                                       "allocation": assigned, "deduction": lost})
                cap_deduction = 0
                if item.get("cap_source"):
                    cap_score = number(source_value(results, item["cap_source"]))
                    if not 0 <= cap_score <= total_max:
                        raise ValueError("白盒总分上限越界")
                    capped = min(earned, allocation * cap_score / total_max)
                    cap_deduction, earned = earned - capped, capped
                deduction = allocation - earned
                detail.update({"dimensions": dimensions, "cap_deduction": cap_deduction})
            else:
                lower, upper = map(number, item.get("range", [0, 100]))
                value = number(raw)
                if upper <= lower or not lower <= value <= upper:
                    raise ValueError(f"加权指标越界: {item['source']}")
                deduction = allocation * (1 - (value - lower) / (upper - lower))
                detail["raw"] = value
            detail.update({"deduction": deduction, "earned": allocation - deduction})
            breakdown.append(detail)
            deductions.append(deduction)
        return ScoreResult(config["dimension"], "scored", round(maximum - sum(deductions), 6), maximum, breakdown)

"""Deterministic scores read explicit, versioned verification fields."""

from pyautorun.harmony_eval.core import scorers, ScoreResult, number


def source_value(results, path):
    parts = str(path).split(".")
    value = results[parts.pop(0)]
    if value.get("status") in ("unavailable", "skipped", "error"):
        raise ValueError(f"评分来源不可用: {path}")
    for part in parts:
        value = value[int(part)] if isinstance(value, list) else value[part]
    if value is None:
        raise ValueError(f"评分来源缺少证据: {path}")
    return value


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


def calculate_scores(results, rules):
    scores = {}
    for config in rules:
        try:
            result = scorers.get(config["type"])().score(results, config)
        except (KeyError, ValueError, TypeError, IndexError) as error:
            result = ScoreResult(config["dimension"], "unavailable", error=str(error))
        scores[config["dimension"]] = result.to_dict()
    return scores

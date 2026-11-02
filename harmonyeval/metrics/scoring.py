"""Apply registered scoring rules without fabricating missing evidence."""

from harmonyeval.api.registry import scorers
from harmonyeval.api.contracts import ScoreResult


def calculate_scores(results, rules):
    scores = {}
    for config in rules:
        try:
            result = scorers.get(config["type"])().score(results, config)
        except (KeyError, ValueError, TypeError, IndexError) as error:
            result = ScoreResult(config["dimension"], "unavailable", error=str(error))
        scores[config["dimension"]] = result.to_dict()
    return scores

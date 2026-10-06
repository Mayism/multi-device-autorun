"""Load the local whitebox scoring rubric and produce the agent snapshot."""

from pathlib import Path
import re


def _nullish(value, fallback):
    return fallback if value is None else value


def load_rubric(task_type, reference_root):
    try:
        import yaml
    except ImportError as error:
        raise RuntimeError("Python 白盒 Rubric 读取需要 PyYAML；安装 pip install '.[whitebox]'") from error
    document = yaml.safe_load((Path(reference_root) / "rubric.yaml").read_text(encoding="utf-8")) or {}
    template = (document.get("task_templates") or {}).get(task_type) or {}
    dimensions = _nullish(template.get("dimensions"), [])
    if not dimensions:
        raise ValueError(f"Rubric template not found for task type: {task_type}")
    force_review = _nullish((document.get("human_review_rules") or {}).get("force_review_when"), [])
    score_bands = [{"min": int(first), "max": int(last)} for rule in force_review
                   for first, last in re.findall(r"(\d+)-(\d+)", str(rule))]
    return {"taskType": task_type,
            "evaluationMode": _nullish((document.get("modes") or {}).get("default_evaluation_mode"),
                                       "auto_precheck_with_human_review"),
            "scenario": _nullish(template.get("scenario"), ""),
            "scoringMethod": _nullish(template.get("scoring_method"), "discrete_band"),
            "scoringNote": _nullish(template.get("scoring_note"), ""),
            "commonRisks": _nullish(template.get("common_risks"), []),
            "reportEmphasis": _nullish(template.get("report_emphasis"), []),
            "dimensions": [{"name": dimension["name"], "weight": dimension["weight"],
                            "intent": _nullish(dimension.get("intent"), ""),
                            "items": [{"name": item["name"], "weight": item["weight"],
                                       "scoringBands": [{"score": band["score"],
                                                         "criteria": band["criteria"]}
                                                        for band in _nullish(item.get("scoring_bands"), [])]}
                                      for item in _nullish(dimension.get("items"), [])]}
                           for dimension in dimensions],
            "hardGates": [{**{"id": gate["id"]}, **({"name": gate["name"]} if "name" in gate else {}),
                           "triggerSignals": _nullish(gate.get("trigger_signals"), []),
                           "scoreCap": gate["score_cap"]}
                          for gate in _nullish(document.get("hard_gates"), [])
                          if task_type in _nullish(gate.get("applies_to"), [])],
            "reviewRules": {"scoreBands": score_bands}}


def rubric_snapshot(rubric):
    return {"task_type": rubric["taskType"], "evaluation_mode": rubric["evaluationMode"],
            "scenario": rubric["scenario"], "scoring_method": rubric["scoringMethod"],
            "scoring_note": rubric["scoringNote"], "common_risks": rubric["commonRisks"],
            "report_emphasis": rubric["reportEmphasis"],
            "dimension_summaries": [{"name": dimension["name"], "weight": dimension["weight"],
                                     "intent": dimension["intent"],
                                     "item_summaries": [{"name": item["name"], "weight": item["weight"],
                                                         "scoring_bands": [{"score": band["score"],
                                                                            "criteria": band["criteria"]}
                                                                           for band in item["scoringBands"]]}
                                                        for item in dimension["items"]]}
                                    for dimension in rubric["dimensions"]],
            "hard_gates": [{"id": gate["id"], "score_cap": gate["scoreCap"]}
                           for gate in rubric["hardGates"]],
            "review_rule_summary": ["关键分段分数需要人工复核"]
                                   if rubric["reviewRules"]["scoreBands"] else []}

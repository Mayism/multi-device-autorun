"""L1/L2/L3 scoring of Autorun case artifacts."""

import json
from pathlib import Path

from pyautorun.reporting.l1_report import load_l1_target


def _number(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} 不是数字")
    return float(value)


def score_whitebox(result):
    """Allocate 50 points to dimension weights, then subtract each dimension's lost share."""
    dimensions = result.get("dimension_results")
    conclusion = result.get("overall_conclusion") or {}
    if not isinstance(dimensions, list) or not dimensions:
        raise ValueError("白盒结果缺少 dimension_results")
    maximum = sum(_number(item.get("max_score"), "max_score") for item in dimensions)
    if maximum <= 0:
        raise ValueError("白盒维度满分必须大于 0")
    breakdown = []
    for item in dimensions:
        cap = _number(item.get("max_score"), "max_score")
        actual = _number(item.get("score"), "score")
        if cap < 0 or not 0 <= actual <= cap:
            raise ValueError(f"白盒维度分数越界: {item.get('dimension_name')}")
        allocation = 50 * cap / maximum
        deduction = allocation * (cap - actual) / cap if cap else 0
        breakdown.append({"dimension": item.get("dimension_name") or "未命名维度",
                          "weight": round(cap / maximum, 4), "allocation": round(allocation, 2),
                          "deduction": round(deduction, 2), "earned": round(allocation - deduction, 2)})
    raw = sum(item["earned"] for item in breakdown)
    total = _number(conclusion.get("total_score"), "overall_conclusion.total_score")
    if not 0 <= total <= maximum:
        raise ValueError("白盒总分越界")
    # The whitebox evaluator has already applied hard gates; preserve their cap here.
    earned = min(raw, 50 * total / maximum)
    return {"score": round(earned, 2), "dimensions": breakdown,
            "overallCapDeduction": round(max(0, raw - earned), 2),
            "l3": round(total, 2),
            "hardGateTriggered": bool(conclusion.get("hard_gate_triggered"))}


def score_case(verdict, whitebox=None, enabled=None):
    enabled = enabled or {"L1", "L2", "L3"}
    scores = {}
    if "L1" in enabled:
        scores["L1"] = {"status": "scored" if verdict.get("present") else "unavailable",
                        "score": verdict.get("score") if verdict.get("present") else None,
                        "buildComplete": verdict.get("buildComplete"),
                        "functionComplete": verdict.get("functionComplete")}
    tests = (verdict.get("totals") or {}).get("testsRun") or 0
    ux_rate = (verdict["totals"].get("passes", 0) / tests) if tests > 0 else None
    if "L2" in enabled:
        if ux_rate is None or whitebox is None:
            scores["L2"] = {"status": "unavailable", "score": None,
                            "reason": "缺少设备 UITest 实际执行结果或白盒评分"}
        else:
            white = score_whitebox(whitebox)
            scores["L2"] = {"status": "scored", "score": round(50 * ux_rate + white["score"], 2),
                            "ux": {"source": "UITest pass rate", "passRate": round(ux_rate, 4),
                                   "earned": round(50 * ux_rate, 2), "weight": 0.5},
                            "whitebox": white}
    if "L3" in enabled:
        scores["L3"] = ({"status": "scored", "score": score_whitebox(whitebox)["l3"],
                         "source": "whitebox.overall_conclusion.total_score"} if whitebox is not None
                        else {"status": "unavailable", "score": None,
                              "reason": "缺少白盒评分"})
    return scores


def score_run(run, enabled):
    run_root = Path(run["runRoot"])
    targets = []
    for target in run.get("targets") or []:
        l1 = load_l1_target(run_root, target)
        case_results = {item.get("case"): item for item in
                        (target.get("summary") or {}).get("results") or [] if isinstance(item, dict)}
        cases = []
        for name, verdict in l1["cases"].items():
            case = case_results.get(name) or {}
            white = case.get("whitebox") or {}
            path = white.get("resultPath") or str(run_root / target["id"] / name / "whitebox" / "outputs" / "result.json")
            try:
                white_result = json.loads(Path(path).read_text(encoding="utf-8")) if Path(path).is_file() else None
            except (OSError, ValueError):
                white_result = None
            cases.append({"case": name, "status": verdict["caseStatus"],
                          "scores": score_case(verdict, white_result, enabled),
                          "whiteboxResultPath": path if white_result is not None else None})
        aggregate = {}
        for dimension in sorted(enabled):
            values = [case["scores"][dimension]["score"] for case in cases
                      if case["scores"][dimension]["status"] == "scored"]
            aggregate[dimension] = {"average": round(sum(values) / len(values), 2) if values else None,
                                    "scoredCases": len(values), "totalCases": len(cases)}
        targets.append({"id": target["id"], "label": target["label"], "error": target.get("error"),
                        "cases": cases, "aggregate": aggregate})
    return {"runId": run["runId"], "runRoot": str(run_root), "targets": targets}

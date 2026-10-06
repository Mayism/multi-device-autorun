"""Deterministic numeric portion of the whitebox rubric and rule fusion."""

import json
import math
from pathlib import Path

from pyautorun.whitebox_eval.resources import ROOT as RESOURCES


METRICS = {
    "type_safety": ["ArkTS/ArkUI语法与类型安全", "ArkTS约束遵循度", "ArkTS/ArkUI规范符合度"],
    "static_quality": ["静态坏味道控制"],
    "naming": ["命名表达清晰度", "命名与风格一致性"],
    "complexity": ["复杂度控制"],
    "state_flow": ["状态与数据流组织", "状态接入合理性"],
    "stability": ["稳定性风险", "回归风险控制"],
    "security_boundary": ["安全与边界意识", "安全/边界意识"],
    "performance": ["性能风险"],
    "arkui_organization": ["ArkUI组织方式合理性"],
    "harmony_engineering": ["HarmonyOS工程实践符合度"],
}


def _round_score(value):
    # JavaScript Math.round rounds positive halves toward +infinity.
    return math.floor(value * 100 + 0.5) / 100


def _key(dimension, item):
    return f"{dimension}::{item}"


def _js_num(value):
    return str(int(value)) if isinstance(value, float) and value.is_integer() else str(value)


def load_scoring_profiles(rules_directory):
    try:
        import yaml
    except ImportError as error:
        raise RuntimeError("Python 白盒评分规则读取需要 PyYAML；安装 pip install '.[whitebox]'") from error
    profiles = {}
    for path in sorted(Path(rules_directory).glob("*.yaml")):
        document = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        for section in ("must_rules", "should_rules", "forbidden_patterns"):
            for rule in document.get(section) or []:
                if rule.get("profile") is not None:
                    profiles[rule["id"]] = rule["profile"]
    return profiles


def load_official_linter_profiles():
    path = RESOURCES / "official_profiles.json"
    return {"OFFICIAL-LINTER:" + item["ruleId"]: item for item in json.loads(path.read_text(encoding="utf-8"))}


def _penalty(metric_names, ratio, severity):
    return {"metricNames": metric_names, "ratio": ratio, "severity": severity}


def find_penalty_rules(rule, profiles, official_profiles):
    rule_id = rule["rule_id"]
    source = rule.get("rule_source")
    if rule_id.startswith("OFFICIAL-LINTER:"):
        official = official_profiles.get(rule_id)
        if not official:
            return []
        severity = {"suggestion": "light", "warn": "medium", "error": "heavy"}.get(
            rule.get("official_linter_severity"), official["severity"])
        return [_penalty(official["metricNames"], official["ratio"], severity)]
    profile = profiles.get(rule_id)
    if profile:
        if not profile.get("scoring"):
            return []
        names = list(dict.fromkeys(name for group in profile["metricGroups"] for name in METRICS.get(group, [])))
        impact = profile["impact"]
        return [_penalty(names, {"heavy": 0.5, "medium": 0.35}.get(impact, 0.15), impact)]
    if rule_id == "ARKUI-MUST-001":
        return [_penalty(METRICS["harmony_engineering"], 0.35, "medium")]
    if rule_id == "ARKUI-FORBID-001":
        return [_penalty(METRICS["arkui_organization"] + METRICS["harmony_engineering"], 0.35, "medium")]
    type_ids = {"ARKTS-FORBID-001", "ARKTS-FORBID-002", "ARKTS-FORBID-003", "ARKTS-MUST-001",
                "ARKTS-FORBID-005", "ARKTS-FORBID-006", "ARKTS-FORBID-007", "ARKTS-FORBID-008",
                "ARKTS-FORBID-009", "ARKTS-FORBID-010", "ARKTS-MUST-003", "ARKTS-MUST-004",
                "ARKTS-FORBID-013", "ARKTS-MUST-005", "ARKTS-MUST-006", "ARKTS-MUST-007",
                "ARKTS-FORBID-016", "ARKTS-FORBID-018", "ARKTS-MUST-009", "ARKTS-SHOULD-002",
                "ARKTS-SHOULD-003", "ARKTS-SHOULD-010", "ARKTS-FORBID-004"}
    naming_ids = {f"ARKTS-SHOULD-{index:03}" for index in range(4, 9)}
    style_ids = {"ARKTS-FORBID-004", "ARKTS-MUST-008", "ARKTS-SHOULD-009", "ARKTS-SHOULD-011"}
    flow_ids = {"ARKTS-FORBID-014", "ARKTS-FORBID-015", "ARKTS-MUST-010", "ARKTS-FORBID-005",
                "ARKTS-FORBID-021", "ARKTS-FORBID-024", "ARKTS-FORBID-025"}
    runtime_ids = {"ARKTS-FORBID-011", "ARKTS-FORBID-012", "ARKTS-FORBID-017", "ARKTS-FORBID-019",
                   "ARKTS-FORBID-020", "ARKTS-FORBID-007", "ARKTS-FORBID-022", "ARKTS-FORBID-023",
                   "ARKTS-PERF-FORBID-001"}
    if rule_id in type_ids:
        names = METRICS["type_safety"] + (METRICS["stability"] + METRICS["security_boundary"]
                                            if source == "forbidden_pattern" else [])
        return [_penalty(names, 0.35 if source == "must_rule" else 0.15,
                         "medium" if source == "must_rule" else "light")]
    if rule_id in naming_ids:
        return [_penalty(METRICS["naming"], 0.15, "light")]
    if rule_id in style_ids:
        return [_penalty(METRICS["static_quality"], 0.25 if source == "must_rule" else 0.15,
                         "medium" if source == "must_rule" else "light")]
    if rule_id in flow_ids:
        return [_penalty(METRICS["complexity"] + METRICS["static_quality"] + METRICS["stability"],
                         0.5 if source == "forbidden_pattern" else 0.25,
                         "heavy" if source == "forbidden_pattern" else "medium")]
    if rule_id == "ARKTS-PERF-FORBID-001":
        return [_penalty(METRICS["performance"] + METRICS["type_safety"], 0.5, "heavy")]
    if rule_id in runtime_ids:
        return [_penalty(METRICS["stability"] + METRICS["security_boundary"] + METRICS["type_safety"],
                         0.5 if source == "forbidden_pattern" else 0.35,
                         "heavy" if source == "forbidden_pattern" else "medium")]
    if rule_id == "ARKTS-SHOULD-001":
        return [_penalty(METRICS["state_flow"] + METRICS["stability"], 0.15, "light")]
    if source == "must_rule":
        return [_penalty(METRICS["type_safety"], 0.35, "medium")]
    if source == "forbidden_pattern":
        return [_penalty(METRICS["stability"] + METRICS["security_boundary"], 0.5, "heavy")]
    return []


def _snap(score, bands):
    if not bands:
        return _round_score(score)
    best = bands[0]["score"]
    for band in bands[1:]:
        current = band["score"]
        if abs(current - score) < abs(best - score) or (abs(current - score) == abs(best - score) and current < best):
            best = current
    return best


def _triggered_gate_ids(data):
    violated = [rule for rule in data["ruleAuditResults"] if rule["result"] == "不满足"]
    must = [rule for rule in violated if rule.get("rule_source") == "must_rule"]
    forbidden = [rule for rule in violated if rule.get("rule_source") == "forbidden_pattern"]
    case_p0 = {rule["rule_id"] for rule in data.get("caseRuleDefinitions", []) if rule.get("priority") == "P0"}
    gates = []
    if any(rule["rule_id"] in case_p0 for rule in violated) or len(must) >= 2:
        gates.append("G1")
    if any(rule["rule_id"] in ("ARKTS-FORBID-003", "ARKTS-FORBID-004", "ARKTS-FORBID-005") for rule in must):
        gates.append("G2")
    if forbidden:
        gates.append("G3")
    evidence = data["evidenceSummary"]
    if data["taskType"] == "bug_fix" and (evidence["changedFileCount"] > 8 or len(evidence["changedFiles"]) > 8):
        gates.append("G4")
    return gates


def compute_numeric_score(data, profiles, official_profiles):
    rubric = data["rubric"]
    snapshot = data["rubricSnapshot"]
    criteria = {_key(dim["name"], item["name"]): " / ".join(f'{_js_num(band["score"])}分：{band["criteria"]}'
                for band in item["scoring_bands"])
                for dim in snapshot["dimension_summaries"] for item in dim["item_summaries"]}
    bands = {_key(dim["name"], item["name"]): item["scoring_bands"]
             for dim in snapshot["dimension_summaries"] for item in dim["item_summaries"]}
    if data["rubricAgentRunStatus"] == "success" and data.get("rubricScoringResult"):
        base_items = data["rubricScoringResult"]["item_scores"]
    else:
        base_items = [{"dimension_name": dim["name"], "item_name": item["name"],
                       "score": item["scoringBands"][0]["score"] if item["scoringBands"] else item["weight"],
                       "matched_band_score": item["scoringBands"][0]["score"] if item["scoringBands"] else item["weight"],
                       "rationale": "rubric agent 未产出可信扣分依据，暂按满分保留，待人工复核。",
                       "evidence_used": [], "confidence": "low"}
                      for dim in rubric["dimensions"] for item in dim["items"]]
    details = {}
    for item in base_items:
        key = _key(item["dimension_name"], item["item_name"])
        details[key] = {"dimension_name": item["dimension_name"], "item_name": item["item_name"],
                        "agent_evaluation": {"base_score": item["score"],
                                             "matched_band_score": item["matched_band_score"],
                                             "matched_criteria": criteria.get(key, ""),
                                             "logic": item["rationale"], "evidence_used": item["evidence_used"],
                                             "confidence": item["confidence"],
                                             "deduction_trace": item.get("deduction_trace")},
                        "rule_impacts": []}
    penalties_by_rule = {}
    for rule in data["ruleAuditResults"]:
        if rule["result"] not in ("不满足", "待人工复核"):
            continue
        penalties = find_penalty_rules(rule, profiles, official_profiles)
        penalties_by_rule[rule["rule_id"]] = penalties
        for detail in details.values():
            penalty = next((candidate for candidate in penalties if detail["item_name"] in candidate["metricNames"]), None)
            if not penalty:
                continue
            delta = 0 if rule["result"] == "待人工复核" else -_round_score(detail["agent_evaluation"]["base_score"] * penalty["ratio"])
            if delta == 0:
                delta = 0
            detail["rule_impacts"].append({"rule_id": rule["rule_id"], "rule_source": rule["rule_source"],
                                           "result": rule["result"],
                                           "severity": "review_only" if rule["result"] == "待人工复核" else penalty["severity"],
                                           "score_delta": delta, "agent_assisted": rule["rule_source"] == "should_rule",
                                           "needs_human_review": rule["result"] == "待人工复核"})
    score_details = []
    for key, detail in details.items():
        delta = _round_score(sum(impact["score_delta"] for impact in detail["rule_impacts"]))
        raw = _round_score(max(0, detail["agent_evaluation"]["base_score"] + delta))
        final = _snap(raw, bands.get(key, []))
        base = detail["agent_evaluation"]["base_score"]
        if delta == 0:
            logic = "未命中影响该评分项的规则，最终分等于 rubric agent 基础分。"
        elif raw == final:
            logic = f"rubric agent 基础分 {_js_num(base)}，规则修正 {_js_num(delta)}，最终 {_js_num(final)}。"
        else:
            logic = (f"rubric agent 基础分 {_js_num(base)}，规则修正 {_js_num(delta)}，"
                     f"原始结果 {_js_num(raw)}，按 rubric 档位收敛为 {_js_num(final)}。")
        detail["score_fusion"] = {"base_score": base, "rule_delta": delta, "final_score": final, "fusion_logic": logic}
        score_details.append(detail)
    dimension_scores = []
    for dim in rubric["dimensions"]:
        metrics = [detail for detail in score_details if detail["dimension_name"] == dim["name"]]
        dimension_scores.append({"dimension_name": dim["name"],
                                 "score": _round_score(sum(item["score_fusion"]["final_score"] for item in metrics)),
                                 "max_score": dim["weight"],
                                 "comment": "包含规则修正项。" if any(item["rule_impacts"] for item in metrics) else "未发现规则修正项。"})
    submetrics = [{"dimension_name": detail["dimension_name"], "metric_name": detail["item_name"],
                   "score": detail["score_fusion"]["final_score"],
                   "confidence": detail["agent_evaluation"]["confidence"],
                   "review_required": detail["agent_evaluation"]["confidence"] == "low" or
                   any(impact["needs_human_review"] for impact in detail["rule_impacts"]),
                   "rationale": detail["score_fusion"]["fusion_logic"],
                   "evidence": " ".join(detail["agent_evaluation"]["evidence_used"] +
                                        [impact["rule_id"] for impact in detail["rule_impacts"]])}
                  for detail in score_details]
    raw_total = _round_score(sum(dim["score"] for dim in dimension_scores))
    gate_ids = _triggered_gate_ids(data)
    build_summary = data.get("hvigorBuildCheckSummary")
    build_gate = bool(build_summary and (build_summary.get("hardGateTriggered") or
                                        build_summary.get("status") in ("tool_unavailable", "failed", "timeout")))
    caps = [gate["scoreCap"] for gate in rubric["hardGates"] if gate["id"] in gate_ids]
    if build_gate:
        caps.append(59 if build_summary.get("scoreCap") is None else build_summary["scoreCap"])
    total = min([raw_total] + caps)
    return {"scoreFusionDetails": score_details, "dimensionScores": dimension_scores,
            "submetricDetails": submetrics, "preCapScore": raw_total, "totalScore": total,
            "triggeredGateIds": gate_ids, "hvigorHardGateTriggered": build_gate,
            "penaltiesByRule": penalties_by_rule}

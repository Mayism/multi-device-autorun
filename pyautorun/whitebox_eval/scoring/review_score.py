"""Recalculate a whitebox score after item and risk human reviews."""

from copy import deepcopy
import math


def _records(value):
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def _round(value):
    return math.floor(value * 100 + 0.5) / 100


def _ids(value):
    return [item.strip() for item in value.split(",") if item.strip()] if isinstance(value, str) else []


def _find(items, identity):
    return next((item for index, item in enumerate(_records(items))
                 if item.get("id", index + 1) == identity), None)


def _add_gates(active, identifiers, caps):
    changed = False
    for identity in identifiers:
        cap = _number((caps or {}).get(identity))
        if cap is not None:
            changed |= active.get(identity) != cap
            active[identity] = cap
    return changed


def _gate_ids(item):
    value = item.get("current_assessment")
    effect = item.get("score_effect") or {}
    return _ids(value) if isinstance(value, str) else effect.get("gate_ids") or []


def _initial_gates(result):
    active = {}
    build = result.get("build_check_summary") or {}
    if build.get("hard_gate_triggered") is True or build.get("hardGateTriggered") is True:
        cap = _number(build.get("score_cap"))
        if cap is None:
            cap = _number(build.get("scoreCap"))
        active["BUILD-CHECK"] = 59 if cap is None else cap
    for risk in _records(result.get("risks")):
        effect = risk.get("score_effect") or {}
        if effect.get("type") != "risk_level_rule_impact":
            continue
        levels = effect.get("hard_gate_active_levels") or []
        if risk.get("level") in levels or not levels and risk.get("level") == "high":
            _add_gates(active, effect.get("hard_gate_ids") or [], effect.get("gate_caps"))
    for item in _records(result.get("human_review_items")):
        effect = item.get("score_effect") or {}
        if effect.get("type") == "hard_gate":
            _add_gates(active, _gate_ids(item), effect.get("gate_caps"))
    overall = result.get("overall_conclusion") or {}
    if not active and overall.get("hard_gate_triggered") is True:
        active["legacy-hard-gate"] = overall["total_score"]
    return active


def _rule_impact(result, rule_id, dimension_name, item_name):
    for dimension in _records(result.get("dimension_results")):
        if dimension.get("dimension_name") != dimension_name:
            continue
        for item in _records(dimension.get("item_results")):
            if item.get("item_name") == item_name:
                return next((impact for impact in _records(item.get("rule_impacts"))
                             if impact.get("rule_id") == rule_id), None)
    return None


def _apply_risk_effect(result, corrected, effect, active):
    rule_id = effect.get("rule_id")
    original_level = effect.get("original_level")
    weights = effect.get("level_weights") or (result.get("score_policy") or {}).get(
        "risk_level_weights") or {}
    original_weight = _number(weights.get(original_level))
    corrected_weight = _number(weights.get(corrected))
    if not rule_id or original_weight in (None, 0) or corrected_weight is None:
        return
    for item in _records(effect.get("impacts")):
        original_delta = _number(item.get("original_score_delta"))
        if original_delta is None:
            continue
        impact = _rule_impact(result, rule_id, item.get("dimension_name"), item.get("item_name"))
        if impact is not None:
            impact["score_delta"] = _round(original_delta / original_weight * corrected_weight)
    active_levels = effect.get("hard_gate_active_levels") or []
    gate_ids = effect.get("hard_gate_ids") or []
    if corrected in active_levels or not active_levels and corrected == "high":
        _add_gates(active, gate_ids, effect.get("gate_caps"))
    else:
        for identity in gate_ids:
            active.pop(identity, None)


def _snap(score, bands):
    if not bands:
        return _round(score)
    return min(bands, key=lambda band: (abs(band - score), band))


def _recalculate(result, active):
    dimensions = _records(result.get("dimension_results"))
    if not dimensions:
        return None, 0, 0
    changed_items = changed_dimensions = 0
    for dimension in dimensions:
        dimension_score = 0
        for item in _records(dimension.get("item_results")):
            previous = _number(item.get("score")) or 0
            base = _number((item.get("agent_evaluation") or {}).get("base_score"))
            if base is None:
                base = previous
            impacts = _records(item.get("rule_impacts"))
            delta = _round(sum(_number(impact.get("score_delta")) or 0 for impact in impacts))
            raw = _round(max(0, base + delta))
            bands = [_number(band.get("score")) for band in _records(
                (item.get("score_recalculation") or {}).get("scoring_bands"))]
            next_score = _snap(raw, [band for band in bands if band is not None])
            item["score"] = next_score
            fusion = item.setdefault("score_fusion", {})
            fusion["rule_delta"] = delta
            fusion["final_score"] = next_score
            fusion["fusion_logic"] = (
                "人工复核后未保留规则扣分，最终分等于基础分。" if delta == 0 else
                f"人工复核后基础分 {base:g}，规则修正 {delta:g}，最终 {next_score:g}。")
            changed_items += next_score != previous
            dimension_score = _round(dimension_score + next_score)
        previous = _number(dimension.get("score")) or 0
        dimension["score"] = dimension_score
        summary = dimension.get("rule_violation_summary")
        if isinstance(summary, dict):
            summary["total_rule_delta"] = _round(sum(
                _number(impact.get("score_delta")) or 0
                for item in _records(dimension.get("item_results"))
                for impact in _records(item.get("rule_impacts"))))
        changed_dimensions += dimension_score != previous
    score = _round(sum(_number(dimension.get("score")) or 0 for dimension in dimensions))
    return min(score, min(active.values())) if active else score, changed_items, changed_dimensions


def apply_human_review_recalculation(result_json, payload, reviewed_at):
    result = deepcopy(result_json)
    overall = result.get("overall_conclusion") or {}
    original = _number(overall.get("total_score"))
    if original is None:
        raise ValueError("overall_conclusion.total_score is required for recalculation")
    original_gate = overall.get("hard_gate_triggered") is True
    active = _initial_gates(result)
    touched = set()
    applied = False
    changed_risks = 0
    item_effects = []
    for review in payload.get("itemReviews") or []:
        item_effects.append({key: review[key] for key in ("itemId", "agree", "reason") if key in review} |
                            {"score_effect_applied": False})
    risk_effects = []
    for review in payload.get("riskReviews") or []:
        risk = _find(result.get("risks"), review["riskId"])
        effect = risk.get("score_effect") if risk else None
        effect_applied = False
        if review["agree"] is False and risk:
            risk["level"] = review["correctedLevel"]
            changed_risks += 1
            if isinstance(effect, dict) and effect.get("type") == "risk_level_rule_impact":
                rule_id = effect.get("rule_id")
                if rule_id in touched:
                    raise ValueError(f"rule_id {rule_id} is reviewed more than once")
                touched.add(rule_id)
                _apply_risk_effect(result, review["correctedLevel"], effect, active)
                effect_applied = applied = True
        risk_effects.append({key: review[key] for key in
                             ("riskId", "agree", "correctedLevel", "reason") if key in review} |
                            {"score_effect_applied": effect_applied})
    for index, review in enumerate(payload.get("itemReviews") or []):
        item = _find(result.get("human_review_items"), review["itemId"])
        effect = item.get("score_effect") if item else None
        if review["agree"] is True and isinstance(effect, dict) and effect.get("type") == "hard_gate":
            if _add_gates(active, _gate_ids(item), effect.get("gate_caps")):
                item_effects[index]["score_effect_applied"] = True
                applied = True
    revised, changed_items, changed_dimensions = _recalculate(result, active)
    if revised is None:
        revised = original
    overall["total_score"] = revised
    overall["hard_gate_triggered"] = bool(active)
    if applied or revised != original or original_gate != bool(active):
        overall["summary"] = f"已根据人工逐条复核重新计分：{original:g} -> {revised:g}。"
    result["overall_conclusion"] = overall
    revision = {"applied": True, "reviewed_at": reviewed_at,
                "score_recalculation": {"original_total_score": original, "revised_total_score": revised,
                    "original_hard_gate_triggered": original_gate,
                    "revised_hard_gate_triggered": bool(active),
                    "changed_item_count": 0, "changed_risk_count": changed_risks},
                "item_reviews": item_effects, "risk_reviews": risk_effects}
    for source, target in (("reviewer", "reviewer"), ("overallComment", "overall_comment")):
        value = payload.get(source)
        if isinstance(value, str) and value.strip():
            revision[target] = value.strip()
    result["human_review_revision"] = revision
    return result, {"scoreRecalculationApplied": applied or revised != original or original_gate != bool(active),
                    "originalTotalScore": original, "revisedTotalScore": revised,
                    "changedItemScoreCount": changed_items,
                    "changedDimensionScoreCount": changed_dimensions}

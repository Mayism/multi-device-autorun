"""Assemble the v2 whitebox result contract in Python."""

from datetime import datetime, timezone


def _unique(values):
    return list(dict.fromkeys(value for value in values if isinstance(value, str) and value.strip()))


def _round(value):
    return round(value + 1e-9, 2)


def _dimension_results(state):
    computation = state["scoreComputation"]
    details = computation["scoreFusionDetails"]
    by_item = {(item["dimension_name"], item["item_name"]): item for item in details}
    by_dimension = {item["dimension_name"]: item for item in computation["dimensionScores"]}
    submetrics = {(item["dimension_name"], item["metric_name"]): item
                  for item in computation["submetricDetails"]}
    result = []
    for dimension in (state.get("rubricSnapshot") or {}).get("dimension_summaries", []):
        name = dimension["name"]
        fusion = [item for item in details if item["dimension_name"] == name]
        logic = _unique([item["agent_evaluation"]["logic"] for item in fusion])
        evidence = _unique([value for item in fusion for value in item["agent_evaluation"]["evidence_used"]])
        confidence = ("low" if not fusion or any(item["agent_evaluation"]["confidence"] == "low" for item in fusion)
                      else "medium" if any(item["agent_evaluation"]["confidence"] == "medium" for item in fusion)
                      else "high")
        violated = {impact["rule_id"] for item in fusion for impact in item["rule_impacts"]
                    if impact["result"] == "不满足"}
        affected = sum(bool(item["rule_impacts"]) for item in fusion)
        delta = _round(sum(item["score_fusion"]["rule_delta"] for item in fusion))
        result_items = []
        for item in dimension["item_summaries"]:
            key = (name, item["name"])
            detail = by_item.get(key)
            sub = submetrics.get(key)
            score = (detail["score_fusion"]["final_score"] if detail else
                     sub["score"] if sub else 0)
            bands = item["scoring_bands"]
            matched = next((band for band in bands if band["score"] == score), None)
            if matched is None and detail:
                matched = next((band for band in bands if band["score"] == detail["agent_evaluation"]["matched_band_score"]), None)
            fallback_evaluation = {"base_score": 0, "matched_band_score": 0,
                                   "matched_criteria": "", "logic": "缺少 rubric agent 对该评分项的评价逻辑。",
                                   "evidence_used": [], "deduction_trace": None, "confidence": "low"}
            fallback_fusion = {"base_score": 0, "rule_delta": 0, "final_score": score,
                               "fusion_logic": "缺少评分融合明细，需人工复核该评分项。"}
            result_items.append({"item_name": item["name"], "item_weight": item["weight"],
                                 "score": score, "matched_band": matched,
                                 "confidence": (detail["agent_evaluation"]["confidence"] if detail else
                                                sub["confidence"] if sub else "low"),
                                 "review_required": (sub["review_required"] if sub else
                                                     any(impact["needs_human_review"] for impact in detail["rule_impacts"])
                                                     if detail else True),
                                 "agent_evaluation": detail["agent_evaluation"] if detail else fallback_evaluation,
                                 "rule_impacts": detail["rule_impacts"] if detail else [],
                                 "score_fusion": detail["score_fusion"] if detail else fallback_fusion})
        score = by_dimension.get(name)
        result.append({"dimension_name": name, "dimension_intent": dimension["intent"],
                       "score": score["score"] if score else 0,
                       "max_score": score["max_score"] if score else dimension["weight"],
                       "comment": score["comment"] if score else "",
                       "agent_evaluation_summary": {
                           "base_score": _round(sum(item["agent_evaluation"]["base_score"] for item in fusion)),
                           "logic": " ".join(logic) if logic else "缺少 rubric agent 评价明细，需人工复核该维度评分依据。",
                           "key_evidence": evidence, "confidence": confidence},
                       "rule_violation_summary": {
                           "violated_rule_count": len(violated), "affected_item_count": affected,
                           "total_rule_delta": delta,
                           "summary": ("该维度未发现规则违规对评分项产生扣分影响。" if not violated else
                                       f"该维度共有 {len(violated)} 条违规规则影响 {affected} 个评分项，累计规则修正 {delta} 分。")},
                       "item_results": result_items})
    return result


def _bound_packs(state):
    packs = state.get("enabledRulePacks") or []
    output = []
    for pack in packs:
        version = str(pack.get("version") or "").strip().removeprefix("v")
        item = {"pack_id": pack["pack_id"], "display_name": pack["display_name"]}
        if version:
            item.update({"version": version, "rule_set": pack["pack_id"] + "@" + version})
        output.append(item)
    seen = {item["pack_id"] for item in output}
    for rule in state.get("caseRuleDefinitions") or []:
        pack_id = rule["pack_id"]
        if pack_id in seen:
            continue
        seen.add(pack_id)
        case_id = pack_id[5:] if pack_id.startswith("case-") and len(pack_id) > 5 else state["caseInput"]["caseId"]
        output.append({"pack_id": pack_id, "display_name": f"用例 {case_id} 约束规则"})
    return output


def _rule_audit(state, effective):
    summaries = {rule["rule_id"]: rule["summary"] for rule in state.get("registeredRules") or []}
    summaries.update({rule["rule_id"]: rule["summary"] for rule in state.get("caseRuleDefinitions") or []})
    by_finding = {}
    for finding in state.get("officialLinterFindings") or []:
        by_finding.setdefault("OFFICIAL-LINTER:" + finding["rule_id"], []).append(finding)
    result = []
    for rule in effective:
        item = {key: rule[key] for key in ("rule_id", "rule_source", "result", "conclusion")}
        item["rule_summary"] = rule.get("rule_summary") or summaries.get(rule["rule_id"], "")
        findings = by_finding.get(rule["rule_id"], [])
        if findings:
            item["finding_count"] = len(findings)
            item["findings"] = [{key: finding[key] for key in
                                  ("file", "line", "column", "severity", "message")}
                                 for finding in findings]
        result.append(item)
    return result


def _build_check(summary):
    if not summary:
        return None
    result = {"enabled": summary["enabled"], "status": summary["status"],
              "checked_modules": summary["checkedModules"],
              "hard_gate_triggered": summary["hardGateTriggered"],
              "duration_ms": summary["durationMs"], "module_results": []}
    for item in summary["moduleResults"]:
        mapped = {"module_path": item["modulePath"], "module_name": item["moduleName"],
                  "command": item["command"], "status": item["status"],
                  "duration_ms": item["durationMs"]}
        for key, target in (("exitCode", "exit_code"), ("diagnostics", "diagnostics")):
            if key in item:
                mapped[target] = item[key]
        result["module_results"].append(mapped)
    for key, target in (("hvigorRunDir", "hvigor_run_dir"), ("buildCheckSource", "build_check_source"),
                        ("scoreCap", "score_cap"), ("diagnostics", "diagnostics")):
        if key in summary:
            result[target] = summary[key]
    return result


def build_result_json(state, generated_at=None):
    computation = state["scoreComputation"]
    overall = computation["overallConclusion"]
    total = overall.get("total_score", computation["totalScore"])
    effective = state.get("mergedRuleAuditResults") or state.get("deterministicRuleResults") or []
    cases = state.get("caseRuleDefinitions") or []
    result = {"schema_version": "result.v2", "basic_info": {
        "rubric_version": "v1", "task_type": state["taskType"],
        "evaluation_mode": "auto_precheck_with_human_review", "rules_enabled": True,
        "build_check_enabled": bool((state.get("hvigorBuildCheckSummary") or {}).get("enabled")),
        "target_description": "HarmonyOS 生成工程评分",
        "target_scope": state["caseInput"]["generatedProjectPath"],
        "task_type_basis": "; ".join((state.get("taskUnderstanding") or {}).get("classificationHints") or [])},
        "overall_conclusion": {**overall, "total_score": total,
                               "pre_cap_score": overall.get("pre_cap_score", total),
                               "hard_gate_triggered": overall.get("hard_gate_triggered", computation["hardGateTriggered"]),
                               "hard_gates": overall.get("hard_gates") if isinstance(overall.get("hard_gates"), list) else [],
                               "summary": overall.get("summary") if isinstance(overall.get("summary"), str) else ""},
        "score_policy": {"risk_level_weights": {"high": 1, "medium": .6, "low": .3, "none": 0}},
        "dimension_results": _dimension_results(state), "bound_rule_packs": _bound_packs(state),
        "risks": computation["risks"], "strengths": computation["strengths"],
        "main_issues": computation["mainIssues"], "human_review_items": computation["humanReviewItems"],
        "final_recommendation": computation["finalRecommendation"],
        "rule_audit_results": _rule_audit(state, effective),
        "official_linter_summary": state.get("officialLinterSummary") or {
            "configuredRuleSets": ["plugin:@typescript-eslint/recommended", "plugin:@security/recommended",
                                   "plugin:@performance/recommended", "plugin:@hw-stylistic/recommended"],
            "effectiveFindingCount": 0, "runStatus": "not_installed", "durationMs": 0},
        "case_rule_results": [{"rule_id": item["rule_id"], "rule_name": item["rule_name"],
                               "priority": item["priority"], "rule_source": item["rule_source"],
                               "result": next((rule["result"] for rule in effective
                                               if rule["rule_id"] == item["rule_id"]), "待人工复核"),
                               "conclusion": next((rule["conclusion"] for rule in effective
                                                   if rule["rule_id"] == item["rule_id"]),
                                                  "缺少最终规则判定结果。"),
                               "hard_gate_triggered": item["priority"] == "P0" and any(
                                   rule["rule_id"] == item["rule_id"] and rule["result"] == "不满足"
                                   for rule in effective)} for item in cases],
        "report_meta": {"result_json_file_name": "result.json", "unit_name": state["caseInput"]["caseId"],
                        "generated_at": generated_at or datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")}}
    build = _build_check(state.get("hvigorBuildCheckSummary"))
    if build:
        result["build_check_summary"] = build
    return result

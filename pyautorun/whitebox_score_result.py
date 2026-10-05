"""Complete Python whitebox score fusion result, including risks and reviews."""

import re

from .whitebox_risk import find_risk_entry, normalize_risk_item, resolve_primary_item
from .whitebox_score_core import compute_numeric_score, find_penalty_rules


def _nullish(value, fallback):
    return fallback if value is None else value


def _anchor(value):
    source = value or ""
    match = re.search(r"(?:generated/|workspace/)?([A-Za-z0-9_.@/-]+\.(?:ets|ts|json|yaml|yml|c|cpp|h|hpp|xml|txt))", source)
    if match:
        return re.sub(r"^(generated|workspace)/", "", match.group(1))
    return re.sub(r":\d+", "", source.strip())[:160]


def _issue_id(entry, task_type, evidence):
    primary = resolve_primary_item(entry, task_type)
    anchor = _anchor(evidence)
    if not primary or not anchor:
        return None
    return ":".join((entry["code"], task_type, primary["dimension"], primary["item"], anchor))


def _rule_issue_id(rule, data, profiles):
    taxonomy = data.get("riskTaxonomy")
    if not taxonomy:
        return None
    profile = profiles.get(rule["rule_id"]) or {}
    code = profile.get("riskCode")
    if not code and rule["rule_id"].startswith("ARKTS-"):
        code = "LANGUAGE_CONSTRAINT_VIOLATION"
    entry = find_risk_entry(taxonomy, code)
    return _issue_id(entry, data["taskType"], rule.get("conclusion")) if entry else None


def _risk_issue_id(risk, data):
    taxonomy = data.get("riskTaxonomy")
    entry = find_risk_entry(taxonomy, risk.get("risk_code")) if taxonomy else None
    return _issue_id(entry, data["taskType"], risk.get("evidence") or risk.get("description")) if entry else None


def _rule_gate_ids(data, rule):
    violated = [item for item in data["ruleAuditResults"] if item["result"] == "不满足"]
    must = [item for item in violated if item.get("rule_source") == "must_rule"]
    case_p0 = {item["rule_id"] for item in data.get("caseRuleDefinitions") or [] if item.get("priority") == "P0"}
    ids = []
    if rule["rule_id"] in case_p0 or (rule.get("rule_source") == "must_rule" and len(must) >= 2):
        ids.append("G1")
    if rule.get("rule_source") == "must_rule" and rule["rule_id"] in (
            "ARKTS-FORBID-003", "ARKTS-FORBID-004", "ARKTS-FORBID-005"):
        ids.append("G2")
    if rule.get("rule_source") == "forbidden_pattern":
        ids.append("G3")
    return ids


def _gate_caps(data, ids):
    return {gate_id: gate["scoreCap"] for gate_id in ids for gate in data["rubric"]["hardGates"]
            if gate["id"] == gate_id}


def _gate_description(gate):
    signals = gate.get("triggerSignals") or []
    if gate["id"] == "G1" and len(signals) >= 4:
        return f'{signals[0]}、{re.sub(r"^大量", "", signals[1])}、{re.sub(r"明显$", "", signals[2])}或{signals[3]}。'
    return "；".join(signals) + "。" if signals else _nullish(gate.get("name"), gate["id"])


def _gate_detail(data, gate_id):
    build = data.get("hvigorBuildCheckSummary") or {}
    if gate_id == "BUILD-CHECK":
        return {"id": gate_id, "name": "工程编译校验未通过", "score_cap": _nullish(build.get("scoreCap"), 59),
                "description": "工程构建或编译校验失败。", "trigger_reason": "构建校验失败触发硬门槛",
                "trigger_policy": {"type": "build_check_status", "status": build.get("status", "failed")},
                "triggered_rule_ids": []}
    gate = next((item for item in data["rubric"]["hardGates"] if item["id"] == gate_id), None)
    if not gate:
        return None
    violated = [rule for rule in data["ruleAuditResults"] if rule["result"] == "不满足"]
    must = [rule for rule in violated if rule.get("rule_source") == "must_rule"]
    forbidden = [rule for rule in violated if rule.get("rule_source") == "forbidden_pattern"]
    case_p0 = {rule["rule_id"] for rule in data.get("caseRuleDefinitions") or [] if rule.get("priority") == "P0"}
    case_violations = [rule for rule in violated if rule["rule_id"] in case_p0]
    reason = "硬门槛触发条件成立"
    policy = {"type": "hard_gate_triggered"}
    rule_ids = []
    if gate_id == "G1" and case_violations:
        reason = "P0 用例约束不满足，触发硬门槛阈值"
        policy = {"type": "case_p0_violation", "threshold": 1, "actual": len(case_violations)}
        rule_ids = [rule["rule_id"] for rule in case_violations]
    elif gate_id == "G1":
        reason = "must_rule 不满足数量达到硬门槛阈值"
        policy = {"type": "must_violation_count", "threshold": 2, "actual": len(must)}
        rule_ids = [rule["rule_id"] for rule in must]
    elif gate_id == "G2":
        specific = [rule for rule in must if rule["rule_id"] in (
            "ARKTS-FORBID-003", "ARKTS-FORBID-004", "ARKTS-FORBID-005")]
        reason = "关键 ArkTS 规范规则不满足"
        policy = {"type": "specific_must_rule_violation", "threshold": 1, "actual": len(specific)}
        rule_ids = [rule["rule_id"] for rule in specific]
    elif gate_id == "G3":
        reason = "forbidden_pattern 不满足数量达到硬门槛阈值"
        policy = {"type": "forbidden_violation_count", "threshold": 1, "actual": len(forbidden)}
        rule_ids = [rule["rule_id"] for rule in forbidden]
    elif gate_id == "G4":
        evidence = data["evidenceSummary"]
        reason = "bug_fix 改动文件数量超过硬门槛阈值"
        policy = {"type": "changed_file_count", "threshold": 8,
                  "actual": max(evidence["changedFileCount"], len(evidence["changedFiles"]))}
    return {"id": gate["id"], "name": _nullish(gate.get("name"), gate["id"]), "score_cap": gate["scoreCap"],
            "description": _gate_description(gate), "trigger_reason": reason,
            "trigger_policy": policy, "triggered_rule_ids": rule_ids}


def _gate_focus(data, triggered, uncertain):
    ids = list(dict.fromkeys(gate_id for candidate in triggered + uncertain for gate_id in candidate["gateIds"]))
    labels = []
    for gate_id in ids:
        gate = next((item for item in data["rubric"]["hardGates"] if item["id"] == gate_id), None)
        if not gate:
            labels.append(gate_id)
            continue
        title = " ".join(str(value) for value in (gate["id"], gate.get("name")) if value)
        signals = f'：{"；".join(gate["triggerSignals"])}' if gate.get("triggerSignals") else ""
        labels.append(f'{title}（总分上限 {gate["scoreCap"]}）{signals}')
    triggered_ids = "；".join(candidate["rule"]["rule_id"] for candidate in triggered)
    pending_ids = "；".join(candidate["rule"]["rule_id"] for candidate in uncertain)
    return (f'硬门槛规则：{"；".join(labels)}。'
            + (f"已触发规则 ID：{triggered_ids}。" if triggered_ids else "")
            + (f"待确认规则 ID：{pending_ids}。" if pending_ids else "")
            + "请确认这些规则判断是否真实成立，以及是否需要保留或触发对应硬门槛。")


def _risk_score_effect(data, rule, level, gate_ids, numeric):
    impacts = [{"dimension_name": detail["dimension_name"], "item_name": detail["item_name"],
                "original_score_delta": impact["score_delta"]}
               for detail in numeric["scoreFusionDetails"] for impact in detail["rule_impacts"]
               if impact["rule_id"] == rule["rule_id"] and impact["score_delta"] != 0]
    if not impacts and not gate_ids:
        return None
    return {"type": "risk_level_rule_impact", "rule_id": rule["rule_id"], "original_level": level,
            "hard_gate_ids": gate_ids, "hard_gate_active_levels": [level] if gate_ids else [],
            "gate_caps": _gate_caps(data, gate_ids), "impacts": impacts}


def _build_risk(build):
    failed = [result for result in build["moduleResults"] if result["status"] in ("failed", "timeout")]
    source = {"remote": "上游提交的编译结果", "agent": "生成 Agent 编译结果"}.get(
        build.get("buildCheckSource"), "hvigor 编译校验")
    modules = "；".join(f'{result["modulePath"]}:{result["command"]}:{result["status"]}' for result in failed)
    if not modules:
        modules = "；".join(build["checkedModules"]) or "未识别模块"
    diagnostics = build.get("diagnostics")
    return {"id": 0, "level": "high", "title": "工程编译校验未通过",
            "description": f'{source}状态为 {build["status"]}，涉及模块：{modules}。'
                           + (f" {diagnostics}" if diagnostics else ""),
            "evidence": diagnostics if diagnostics is not None else modules}


def _deprecated_risk(build, risk_id):
    warnings = build.get("deprecatedApiWarnings") or []
    if not warnings:
        return None
    examples = "；".join(f'{item["file"]}:{item["line"]}:{item["column"]} \'{item["apiName"]}\''
                        for item in warnings[:3])
    first = warnings[0]
    return {"id": risk_id, "level": "medium", "title": "新增代码使用废弃 API",
            "description": f'新增代码使用了 {len(warnings)} 处废弃 API，'
                           f'例如 {first["file"]}:{first["line"]} 的 {first["apiName"]}，后续版本可能移除或行为变化。',
            "evidence": f"hvigor warning: {examples}", "risk_code": "DEPRECATED_API_USAGE",
            "risk_category": "medium"}


def _build_conclusion(build):
    failure = next((item for item in build.get("moduleResults", [])
                    if item["command"] == "assembleApp" and item["status"] in ("failed", "timeout")), None)
    if not failure:
        return None
    return _nullish(build.get("diagnostics"), _nullish(
        failure.get("diagnostics"),
        "整包 assembleApp 编译未通过：组件包可编译，但整包编译未通过，判断为原代码问题，非新增修改引入。"))


def compute_score_computation(data, profiles, official_profiles):
    numeric = compute_numeric_score(data, profiles, official_profiles)
    taxonomy = data.get("riskTaxonomy")
    rubric_result = data.get("rubricScoringResult") or {}
    rule_issue_ids = {_rule_issue_id(rule, data, profiles) for rule in data["ruleAuditResults"]
                      if rule["result"] == "不满足"}
    risks = []
    for index, risk in enumerate(rubric_result.get("risks") or []):
        normalized = normalize_risk_item({**risk, "id": index + 1}, taxonomy) if taxonomy else {**risk, "id": index + 1}
        if _risk_issue_id(normalized, data) not in rule_issue_ids or _risk_issue_id(normalized, data) is None:
            risks.append(normalized)
    build = data.get("hvigorBuildCheckSummary")
    if numeric["hvigorHardGateTriggered"] and build:
        risks.append({**_build_risk(build), "id": len(risks) + 1})
    if build:
        deprecated = _deprecated_risk(build, len(risks) + 1)
        if deprecated:
            risks.append(deprecated)
    for rule in data["ruleAuditResults"]:
        if rule["result"] != "不满足":
            continue
        penalties = find_penalty_rules(rule, profiles, official_profiles)
        severities = {penalty["severity"] for penalty in penalties}
        level = ("high" if "heavy" in severities else "medium" if "medium" in severities else
                 "low" if "light" in severities else
                 "high" if rule.get("rule_source") == "forbidden_pattern" else "medium")
        gate_ids = _rule_gate_ids(data, rule)
        risk = {"id": len(risks) + 1, "level": level, "title": f'规则违规：{rule["rule_id"]}',
                "risk_code": f'RULE_VIOLATION:{rule["rule_id"]}', "risk_category": level,
                "source_rule_id": rule["rule_id"], "evidence": rule["conclusion"]}
        effect = _risk_score_effect(data, rule, level, gate_ids, numeric)
        if effect:
            risk["score_effect"] = effect
        risks.append(risk)
    gate_ids = numeric["triggeredGateIds"]
    hard_gate_reasons = gate_ids + (["BUILD-CHECK"] if numeric["hvigorHardGateTriggered"] else [])
    hard_gates = [detail for gate_id in hard_gate_reasons if (detail := _gate_detail(data, gate_id))]
    triggered = [{"gateIds": _rule_gate_ids(data, rule), "rule": rule}
                 for rule in data["ruleAuditResults"] if rule["result"] == "不满足"]
    triggered = [item for item in triggered if item["gateIds"]]
    uncertain = [{"gateIds": _rule_gate_ids(data, rule), "rule": rule}
                 for rule in data["ruleAuditResults"] if rule["result"] == "待人工复核"]
    uncertain = [item for item in uncertain if item["gateIds"]]
    review = []
    if data["rubricAgentRunStatus"] != "success":
        review.append({"id": 1, "item": "Rubric Agent 降级",
                       "current_assessment": "rubric agent 未产出可信扣分依据，当前按满分保留。",
                       "uncertainty_reason": f'rubricAgentRunStatus={data["rubricAgentRunStatus"]}',
                       "suggested_focus": "人工复核 rubric 逐项评分是否合理。"})
    if triggered or uncertain:
        candidate_ids = list(dict.fromkeys(gate_id for item in triggered + uncertain for gate_id in item["gateIds"]))
        current_ids = list(dict.fromkeys(gate_id for item in triggered for gate_id in item["gateIds"]))
        first = _gate_detail(data, current_ids[0]) if current_ids else None
        policy = first.get("trigger_policy") if first else None
        effect = {"type": "hard_gate", "gate_ids": candidate_ids, "gate_caps": _gate_caps(data, candidate_ids)}
        if first and first.get("trigger_reason"):
            effect["trigger_reason"] = first["trigger_reason"]
        if policy:
            effect["trigger_policy"] = policy
        if current_ids:
            effect["triggered_rule_ids"] = list(dict.fromkeys(item["rule"]["rule_id"] for item in triggered))
        review.append({"id": len(review) + 1, "item": "硬门槛复核",
                       "current_assessment": ",".join(current_ids) if current_ids else "none",
                       "uncertainty_reason": (f'{first["id"]} {first["name"]}：{first["trigger_reason"]}。'
                                              if current_ids and first else
                                              "以下规则可能触发硬门槛但 agent 无法确认："
                                              + ", ".join(item["rule"]["rule_id"] for item in uncertain) + "。"),
                       "suggested_focus": _gate_focus(data, triggered, uncertain), "score_effect": effect})
    for rule in data["ruleAuditResults"]:
        if rule["result"] != "待人工复核":
            continue
        ids = _rule_gate_ids(data, rule)
        review.append({"id": len(review) + 1, "item": f'规则判定复核：{rule["rule_id"]}',
                       "current_assessment": rule["result"], "uncertainty_reason": rule["conclusion"],
                       "suggested_focus": f'请人工确认规则 {rule["rule_id"]} 的判定是否可信，并核对规则结论：{rule["conclusion"]}',
                       "score_effect": {"type": "rule_result", "rule_ids": [rule["rule_id"]],
                                        "hard_gate_ids": ids, "gate_caps": _gate_caps(data, ids)}})
    conclusion_detail = _build_conclusion(build) if numeric["hvigorHardGateTriggered"] and build else None
    summary = ("已完成 rubric 基础评分与规则修正融合，并触发硬门槛：" + ", ".join(hard_gate_reasons) + "。"
               + (f" {conclusion_detail}" if conclusion_detail else "") if hard_gate_reasons else
               "已完成 rubric 基础评分与规则修正融合。")
    return {"totalScore": numeric["totalScore"], "hardGateTriggered": bool(hard_gate_reasons),
            "hardGateReason": ", ".join(hard_gate_reasons),
            "overallConclusion": {"total_score": numeric["totalScore"],
                                  "pre_cap_score": numeric["preCapScore"],
                                  "hard_gate_triggered": bool(hard_gate_reasons),
                                  "hard_gates": hard_gates, "summary": summary},
            "dimensionScores": numeric["dimensionScores"],
            "submetricDetails": numeric["submetricDetails"],
            "scoreFusionDetails": numeric["scoreFusionDetails"],
            "risks": risks, "humanReviewItems": review,
            "strengths": rubric_result.get("strengths") or [],
            "mainIssues": rubric_result.get("main_issues") or [],
            "finalRecommendation": ["当前分数可作为 rubric-first 自动预检结果使用。"]}

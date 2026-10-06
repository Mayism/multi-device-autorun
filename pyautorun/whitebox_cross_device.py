"""Cross-device dashboard projections over Python whitebox artifacts."""

import json
from pathlib import Path

from .whitebox_dashboard import filter_tasks
from .whitebox_service_stats import registered_rule_metadata
from .whitebox_review_dataset import read_dataset


CROSS_PACK = "cross-device-adaptation"
CROSS_SET = "plugin:@cross-device-app-dev/recommended"


def _read(path):
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def related_tasks(records, summaries):
    packs, metadata = registered_rule_metadata()
    names = {pack["packId"]: pack["displayName"] for pack in packs}
    by_id = {item["taskId"]: item for item in summaries}
    tasks = []
    for record in records:
        case_dir = record.get("caseDir")
        if not case_dir:
            continue
        understanding = _read(Path(case_dir) / "intermediate" / "task-understanding.json")
        if not understanding:
            understanding = _read(Path(case_dir) / "intermediate" / "constraint-summary.json")
        cross = understanding.get("crossDeviceAdaptation") or {}
        if cross.get("applicability") != "involved":
            continue
        result = _read(Path(case_dir) / "outputs" / "result.json")
        base = by_id.get(record["taskId"])
        if not base:
            continue
        audits = []
        for rule in result.get("rule_audit_results") or []:
            if not isinstance(rule, dict) or not rule.get("rule_id"):
                continue
            meta = metadata.get(rule["rule_id"]) or {}
            pack_id = meta.get("pack_id")
            audits.append({"packId": pack_id, "packDisplayName": names.get(pack_id),
                "ruleId": rule["rule_id"], "ruleSummary": rule.get("rule_summary"),
                "ruleSource": rule.get("rule_source"), "result": rule.get("result"),
                "conclusion": rule.get("conclusion")})
        cross_audits = [item for item in audits if item["packId"] == CROSS_PACK]
        official = []
        for rule in result.get("rule_audit_results") or []:
            if not isinstance(rule, dict) or not str(rule.get("rule_id", "")).startswith("OFFICIAL-LINTER:"):
                continue
            name = rule["rule_id"].removeprefix("OFFICIAL-LINTER:")
            official.append({"ruleId": name, "ruleResultId": rule["rule_id"],
                "sourceRuleSet": CROSS_SET if name.startswith("@cross-device-app-dev/") else "",
                "severity": (rule.get("findings") or [{}])[0].get("severity"),
                "findingCount": rule.get("finding_count") or 1,
                "conclusion": rule.get("conclusion")})
        cross_official = [item for item in official if item["ruleId"].startswith("@cross-device-app-dev/")]
        top = sorted(({"ruleId": item["ruleId"], "sourceRuleSet": CROSS_SET,
                       "findingCount": item["findingCount"]} for item in cross_official),
                     key=lambda item: -item["findingCount"])[:5]
        risks = base["risks"]
        levels = {}
        for risk in risks:
            level = risk.get("level")
            if level:
                levels[level] = levels.get(level, 0) + 1
        tasks.append({**base, "reasons": [item for item in cross.get("reasons") or []
                                              if isinstance(item, str)],
            "officialLinterRunStatus": (result.get("official_linter_summary") or {}).get("runStatus"),
            "crossDeviceRuleSetApplied": CROSS_SET in (result.get("official_linter_summary") or
                                                        {}).get("configuredRuleSets", []),
            "crossDeviceFindingCount": sum(item["findingCount"] for item in top),
            "riskCount": len(risks),
            "boundRulePacks": [{"packId": item["pack_id"],
                                "displayName": item.get("display_name") or names.get(item["pack_id"],
                                                                                       item["pack_id"])}
                               for item in result.get("bound_rule_packs") or [] if isinstance(item, dict)
                               and item.get("pack_id")],
            "crossDeviceRuleAuditCounts": {"violated": sum(item["result"] == "不满足" for item in cross_audits),
                "review": sum(item["result"] == "待人工复核" for item in cross_audits),
                "satisfied": sum(item["result"] == "满足" for item in cross_audits),
                "notInvolved": sum(item["result"] == "不涉及" for item in cross_audits),
                "total": len(cross_audits)},
            "crossDeviceRuleAuditResults": cross_audits,
            "crossDeviceOfficialLinterResults": cross_official,
            "topRuleViolations": top,
            "riskLevelCounts": [{"level": key, "count": value} for key, value in levels.items()],
            "officialLinterResults": official, "ruleAuditResults": audits})
    return tasks


def cases_page(tasks, query):
    selected = filter_tasks(tasks, query, date_field="updatedAt")
    sort_by = query.get("sortBy", "updatedAt")
    if sort_by not in ("updatedAt", "score", "taskId"):
        raise ValueError("invalid sortBy")
    selected.sort(key=lambda row: (row[sort_by] is None, row[sort_by]),
                  reverse=query.get("sortOrder", "desc") == "desc")
    page = int(query.get("page", 1))
    size = int(query.get("pageSize", 20))
    if page < 1 or not 1 <= size <= 100:
        raise ValueError("page and pageSize must be positive integers")
    items = [{key: value for key, value in row.items() if key not in
              ("officialLinterResults", "ruleAuditResults", "risks")}
             for row in selected[(page - 1) * size:page * size]]
    return {"success": True, "page": page, "pageSize": size, "total": len(selected), "items": items}


def rule_violations_page(tasks, query):
    selected = filter_tasks(tasks, {key: query[key] for key in ("from", "to") if key in query},
                            date_field="updatedAt")
    counts = {}
    include_other = query.get("includeOtherRules") in ("true", True)
    for task in selected:
        for rule in task["ruleAuditResults"]:
            if rule["result"] != "不满足" or rule["ruleId"].startswith("OFFICIAL-LINTER:"):
                continue
            if not include_other and rule["packId"] != CROSS_PACK:
                continue
            name = rule["ruleId"]
            item = counts.setdefault(name, {"ruleId": name, "ruleSummary": rule["ruleSummary"],
                "sourceRuleSet": rule["ruleSource"], "violationCount": 0,
                "affectedTaskIds": set(), "lastViolatedAt": ""})
            item["violationCount"] += 1
            item["affectedTaskIds"].add(task["taskId"])
            item["lastViolatedAt"] = max(item["lastViolatedAt"], task["updatedAt"])
    items = [{**item, "affectedTaskCount": len(item["affectedTaskIds"]),
              "affectedTaskIds": sorted(item["affectedTaskIds"])} for item in counts.values()]
    keyword = str(query.get("keyword") or "").lower()
    if keyword:
        items = [item for item in items if keyword in
                 (item["ruleId"] + " " + str(item["ruleSummary"])).lower()]
    items.sort(key=lambda item: (-item["violationCount"], item["ruleId"]))
    page = int(query.get("page", 1))
    size = int(query.get("pageSize", 20))
    if page < 1 or not 1 <= size <= 100:
        raise ValueError("page and pageSize must be positive integers")
    return {"success": True, "page": page, "pageSize": size, "total": len(items),
            "summary": {"relatedCaseCount": len(selected), "violatedRuleCount": len(items),
                        "totalViolationEvents": sum(item["violationCount"] for item in items)},
            "items": items[(page - 1) * size:page * size]}


def risk_review_page(tasks, query, review_root):
    selected = filter_tasks(tasks, {key: query[key] for key in ("from", "to") if key in query},
                            date_field="updatedAt")
    task_ids = {task["taskId"] for task in selected}
    names = {task["taskId"]: task["name"] for task in selected}
    dataset = read_dataset(review_root, "risk_review_calibration", names)
    items = []
    keyword = str(query.get("keyword") or "").lower()
    for item in dataset["items"]:
        if item["taskId"] not in task_ids:
            continue
        agreed = (item.get("humanReview") or {}).get("agreeWithResultLevel",
                  (item.get("humanReview") or {}).get("agree"))
        if query.get("agreement") == "agreed" and agreed is not True:
            continue
        if query.get("agreement") == "disagreed" and agreed is not False:
            continue
        if query.get("riskLevel") and (item.get("resultRisk") or {}).get("level") != query["riskLevel"]:
            continue
        if keyword and keyword not in " ".join(str(item.get(key) or "") for key in
                                               ("taskId", "testCaseId", "caseName")).lower():
            continue
        items.append(item)
    page = int(query.get("page", 1))
    size = int(query.get("pageSize", 100))
    if page < 1 or not 1 <= size <= 500:
        raise ValueError("page and pageSize must be positive integers")
    return {"success": True, "page": page, "pageSize": size, "total": len(items),
            "skippedRows": dataset["skippedRows"], "items": items[(page - 1) * size:page * size]}

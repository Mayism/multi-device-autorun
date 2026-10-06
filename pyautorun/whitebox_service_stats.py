"""Python extraction and aggregation of whitebox rule violation history."""

from datetime import datetime, timezone
from pathlib import Path

from .whitebox_rule_registry import load_rule_packs
from .whitebox_resources import REFERENCES


def _milliseconds(value):
    if isinstance(value, (int, float)):
        return int(value)
    if not isinstance(value, str):
        raise ValueError("timestamp must be an ISO string")
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def registered_rule_metadata(repo_root=None):
    references = (Path(repo_root) / "pyautorun" / "whitebox_resources" / "references"
                  if repo_root else REFERENCES)
    packs = load_rule_packs(references / "rules")
    rules = {rule["rule_id"]: {"pack_id": pack["packId"],
                              "pack_display_name": pack["displayName"],
                              "rule_summary": rule["summary"],
                              "rule_source": rule["rule_source"]}
             for pack in packs for rule in pack["rules"]}
    return packs, rules


def extract_rule_violations(result, *, repo_root=None):
    _packs, metadata = registered_rule_metadata(repo_root)
    output = []
    for item in result.get("rule_audit_results") or []:
        if not isinstance(item, dict) or item.get("result") != "不满足":
            continue
        rule = metadata.get(item.get("rule_id"))
        if rule:
            output.append({**rule, "rule_id": item["rule_id"],
                           "rule_summary": item.get("rule_summary") or rule["rule_summary"],
                           "conclusion": item.get("conclusion") or ""})
    return output


def build_rule_stats(runs, query, *, repo_root=None):
    packs, _rules = registered_rule_metadata(repo_root)
    known_packs = {pack["packId"] for pack in packs}
    for key in ("from", "to"):
        if key in query:
            try:
                _milliseconds(query[key])
            except ValueError as error:
                raise ValueError(f"Invalid query parameter: {key} must be an ISO timestamp") from error
    test_case_id = query.get("testCaseId")
    if test_case_id is not None:
        try:
            test_case_id = int(test_case_id)
        except ValueError as error:
            raise ValueError("Invalid query parameter: testCaseId must be a number") from error
    filters = {key: value for key, value in query.items()
               if key in ("caseId", "testCaseId", "packId", "from", "to")}
    if test_case_id is not None:
        filters["testCaseId"] = test_case_id
    selected = []
    for run in runs:
        if query.get("caseId") is not None and run["caseId"] != query["caseId"]:
            continue
        if test_case_id is not None and run["testCaseId"] != test_case_id:
            continue
        if query.get("packId") is not None and (query["packId"] not in known_packs or
                all(item["pack_id"] != query["packId"] for item in run["rules"])):
            continue
        if query.get("from") is not None and run["completedAt"] < _milliseconds(query["from"]):
            continue
        if query.get("to") is not None and run["completedAt"] > _milliseconds(query["to"]):
            continue
        selected.append(run)
    stats = {}
    for run in selected:
        for item in run["rules"]:
            if query.get("packId") and item["pack_id"] != query["packId"]:
                continue
            key = (item["pack_id"], item["rule_id"])
            row = stats.setdefault(key, {"pack_id": item["pack_id"], "rule_id": item["rule_id"],
                "rule_summary": item["rule_summary"], "rule_source": item["rule_source"],
                "violationCount": 0, "affectedCaseIds": set(), "affectedTaskIds": set(),
                "lastViolatedAt": 0})
            row["violationCount"] += 1
            row["affectedCaseIds"].add(run["caseId"])
            row["affectedTaskIds"].add(run["taskId"])
            row["lastViolatedAt"] = max(row["lastViolatedAt"], run["completedAt"])
    rules = []
    for row in stats.values():
        cases = sorted(row.pop("affectedCaseIds"))
        tasks = sorted(row.pop("affectedTaskIds"))
        rules.append({**row, "affectedCaseIds": cases, "affectedTaskIds": tasks,
            "affectedCaseCount": len(cases), "affectedRunCount": len(tasks),
            "lastViolatedAt": datetime.fromtimestamp(row["lastViolatedAt"] / 1000, timezone.utc)
                              .isoformat(timespec="milliseconds").replace("+00:00", "Z")})
    rules.sort(key=lambda item: (-item["violationCount"], item["pack_id"], item["rule_id"]))
    return {"success": True, "filters": filters,
            "summary": {"totalRuns": len(selected), "caseCount": len({row["caseId"] for row in selected}),
                        "violatedRuleCount": len(rules),
                        "totalViolationEvents": sum(row["violationCount"] for row in rules)},
            "rules": rules}

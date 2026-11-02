"""Dashboard task and negative-result aggregates in Python."""

from datetime import datetime, timezone


def _parse_date(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError) as error:
        raise ValueError("invalid date filter") from error


def filter_tasks(tasks, query, *, date_field="createdAt"):
    selected = []
    minimum = float(query["scoreMin"]) if query.get("scoreMin") else None
    maximum = float(query["scoreMax"]) if query.get("scoreMax") else None
    begin = _parse_date(query["from"]) if query.get("from") else None
    end = _parse_date(query["to"]) if query.get("to") else None
    keyword = query.get("keyword", "").strip().lower()
    for task in tasks:
        if query.get("status") and task["statusCategory"] != query["status"]:
            continue
        if query.get("taskType") and task["taskType"] != query["taskType"]:
            continue
        created = _parse_date(task[date_field])
        if begin is not None and created < begin or end is not None and created > end:
            continue
        if minimum is not None and (task["score"] is None or task["score"] < minimum):
            continue
        if maximum is not None and (task["score"] is None or task["score"] > maximum):
            continue
        if keyword and keyword not in " ".join((str(task["taskId"]), str(task.get("testCaseId") or ""),
                                                  task["name"])).lower():
            continue
        selected.append(task)
    return selected


def summary(tasks):
    statuses = {key: 0 for key in ("received", "queued", "running", "completed", "failed")}
    task_types = {}
    scores = []
    for item in tasks:
        statuses[item["statusCategory"]] += 1
        task_types[item["taskType"]] = task_types.get(item["taskType"], 0) + 1
        if item["statusCategory"] == "completed" and isinstance(item.get("score"), (int, float)):
            scores.append(item["score"])
    return {"statusCounts": statuses,
            "taskTypeCounts": [{"taskType": key, "count": task_types[key]} for key in sorted(task_types)],
            "scoreSummary": {"completedWithScore": len(scores),
                             "averageScore": round(sum(scores) / len(scores), 2) if scores else None,
                             "minScore": min(scores) if scores else None,
                             "maxScore": max(scores) if scores else None}}


def negative_results(tasks, rule_runs, threshold=70):
    recent = lambda values: sorted(values, key=lambda item: (item["createdAt"], item["taskId"]), reverse=True)
    failed = recent([item for item in tasks if item["statusCategory"] == "failed"])
    low_score = recent([item for item in tasks if isinstance(item.get("score"), (int, float))
                        and item["score"] < threshold])
    hard_gate = recent([item for item in tasks if item.get("hardGateTriggered") is True])
    high_risk = [item for item in tasks if any(risk.get("level") == "high" for risk in item["risks"])]
    risk_counts = {}
    for task in tasks:
        for risk in task["risks"]:
            level = risk.get("level")
            if level:
                risk_counts[level] = risk_counts.get(level, 0) + 1
    task_ids = {item["taskId"] for item in tasks}
    stats = {}
    for run in rule_runs:
        if run["taskId"] not in task_ids:
            continue
        for rule in run["rules"]:
            if rule["result"] != "不满足":
                continue
            key = (rule["pack_id"], rule["rule_id"])
            item = stats.setdefault(key, {"pack_id": rule["pack_id"], "rule_id": rule["rule_id"],
                "rule_summary": rule["rule_summary"], "violationCount": 0,
                "affectedTaskIds": set(), "lastViolatedAt": 0})
            item["violationCount"] += 1
            item["affectedTaskIds"].add(run["taskId"])
            item["lastViolatedAt"] = max(item["lastViolatedAt"], run["completedAt"])
    violations = [{**row, "affectedTaskIds": sorted(row["affectedTaskIds"]),
                   "lastViolatedAt": datetime.fromtimestamp(row["lastViolatedAt"] / 1000, timezone.utc)
                                     .isoformat(timespec="milliseconds").replace("+00:00", "Z")}
                  for row in stats.values()]
    violations.sort(key=lambda row: (-row["violationCount"], row["rule_id"]))
    return {"summary": {"totalCaseCount": len(tasks), "failedTaskCount": len(failed),
                        "lowScoreTaskCount": len(low_score), "hardGateTaskCount": len(hard_gate),
                        "highRiskTaskCount": len(high_risk), "violatedRuleCount": len(violations)},
            "failedTasks": failed, "lowScoreTasks": low_score, "hardGateTasks": hard_gate,
            "riskLevelCounts": [{"level": level, "count": count} for level, count in risk_counts.items()],
            "topRuleViolations": violations}

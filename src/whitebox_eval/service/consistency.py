"""Patch and normalize consistency task records without Node."""


VALID_RUN_STATUSES = {"pending_submit", "submitted", "preparing", "queued", "running",
                      "completed", "failed", "timed_out", "missing"}


def normalize_consistency(item):
    result = {key: value for key, value in item.items() if key not in
              ("analysis", "ruleReport", "riskReport")}
    if isinstance(result.get("runs"), list):
        result["runs"] = [{**run, "status": run.get("status") if run.get("status") in
                           VALID_RUN_STATUSES else "pending_submit"}
                          if isinstance(run, dict) and isinstance(run.get("status"), str)
                          else run for run in result["runs"]]
    return result


def merge_consistency_patch(existing, patch):
    if not isinstance(patch, dict):
        raise ValueError("Invalid request body: consistency task patch is required")
    for key in ("updatedAt", "status"):
        if key in patch and not isinstance(patch[key], str):
            raise ValueError(f"{key} must be a string")
    if "replaceRuns" in patch and not isinstance(patch["replaceRuns"], bool):
        raise ValueError("replaceRuns must be a boolean")
    for key in ("runs", "analysisHistory"):
        if key in patch and (not isinstance(patch[key], list) or any(
                not isinstance(item, dict) for item in patch[key])):
            raise ValueError(f"{key} must be an array of objects")
    merged = dict(existing)
    for key in ("updatedAt", "status"):
        if key in patch:
            merged[key] = patch[key]
    if "runs" in patch:
        runs = [] if patch.get("replaceRuns") else list(existing.get("runs") or [])
        indexes = {run["taskId"]: index for index, run in enumerate(runs)
                   if isinstance(run, dict) and isinstance(run.get("taskId"), int)}
        for run in patch["runs"]:
            task_id = run.get("taskId")
            if not isinstance(task_id, int):
                continue
            if task_id in indexes:
                runs[indexes[task_id]] = run
            else:
                indexes[task_id] = len(runs)
                runs.append(run)
        indexed = {}
        unindexed = []
        for run in runs:
            if isinstance(run, dict) and isinstance(run.get("runIndex"), int):
                indexed[run["runIndex"]] = run
            else:
                unindexed.append(run)
        merged["runs"] = [indexed[key] for key in sorted(indexed)] + unindexed
    if "analysisHistory" in patch:
        history = list(existing.get("analysisHistory") or [])
        keys = {(item.get("round"), item.get("capturedAt")) for item in history
                if isinstance(item, dict)}
        for item in patch["analysisHistory"]:
            key = (item.get("round"), item.get("capturedAt"))
            if key not in keys:
                history.append(item)
                keys.add(key)
        merged["analysisHistory"] = history
    return normalize_consistency(merged)

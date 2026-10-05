"""Load and normalize the whitebox risk taxonomy in Python."""

from pathlib import Path


TASK_KEYS = ("all", "full_generation", "continuation", "bug_fix")
ENTRY_KEYS = {"code", "level", "title", "description", "matchHints", "match_hints",
              "primaryItem", "primary_item", "primaryItemsByTask", "primary_items_by_task"}


def _record(value, location):
    if not isinstance(value, dict):
        raise ValueError(f"{location} must be an object")
    return value


def _keys(record, supported, location):
    for key in record:
        if key not in supported:
            raise ValueError(f"Unsupported field at {location}: {key}")


def _string(value, location):
    if not isinstance(value, str):
        raise ValueError(f"{location} must be a string")
    return value


def _primary_item(value, location):
    record = _record(value, location)
    _keys(record, {"dimension", "item"}, location)
    return {key: _string(record.get(key), f"{location}.{key}") for key in ("dimension", "item")}


def _parse_entries(value, location, require_primary):
    entries = [] if value is None else value
    if not isinstance(entries, list):
        raise ValueError(f"{location} must be an array")
    normalized = []
    for index, value in enumerate(entries):
        where = f"{location}[{index}]"
        record = _record(value, where)
        _keys(record, ENTRY_KEYS, where)
        entry = {key: _string(record.get(key), f"{where}.{key}")
                 for key in ("code", "level", "title", "description")}
        if entry["level"] not in ("low", "medium", "high"):
            raise ValueError(f"{where}.level must be one of low, medium, high")
        hints = record.get("matchHints", record.get("match_hints", []))
        if not isinstance(hints, list) or any(not isinstance(item, str) for item in hints):
            raise ValueError(f"{where}.matchHints must only contain strings")
        entry["matchHints"] = hints
        primary = record.get("primaryItem", record.get("primary_item"))
        by_task = record.get("primaryItemsByTask", record.get("primary_items_by_task"))
        if by_task is not None:
            by_task = _record(by_task, f"{where}.primaryItemsByTask")
            _keys(by_task, TASK_KEYS, f"{where}.primaryItemsByTask")
            by_task = {key: _primary_item(by_task[key], f"{where}.primaryItemsByTask.{key}")
                       for key in TASK_KEYS if key in by_task}
        if primary is not None:
            primary = _primary_item(primary, f"{where}.primaryItem")
        elif by_task:
            primary = next((by_task[key] for key in TASK_KEYS if key in by_task), None)
        if require_primary and primary is None and by_task is None:
            raise ValueError(f"{where}.primaryItem is required for score taxonomy entries")
        if primary is not None:
            entry["primaryItem"] = primary
        if by_task is not None:
            entry["primaryItemsByTask"] = by_task
        normalized.append(entry)
    return normalized


def load_risk_taxonomy(file_path):
    try:
        import yaml
    except ImportError as error:
        raise RuntimeError("Python 白盒风险分类表读取需要 PyYAML；安装 pip install '.[whitebox]'") from error
    path = Path(file_path)
    if not path.is_file():
        raise ValueError(f"risk taxonomy file not found: {path.resolve()}")
    root = _record(yaml.safe_load(path.read_text(encoding="utf-8")), str(path))
    _keys(root, {"version", "entries", "score_taxonomy", "review_only_taxonomy"}, str(path))
    version = root.get("version") if isinstance(root.get("version"), str) else "v1"
    if "score_taxonomy" in root or "review_only_taxonomy" in root:
        score = _parse_entries(root.get("score_taxonomy"), f"{path}.score_taxonomy", True)
        review = _parse_entries(root.get("review_only_taxonomy"), f"{path}.review_only_taxonomy", False)
    else:
        entries = _parse_entries(root.get("entries"), f"{path}.entries", False)
        score = [entry for entry in entries if entry["code"] != "EVALUATION_METADATA_RISK"]
        review = [entry for entry in entries if entry["code"] == "EVALUATION_METADATA_RISK"]
    return {"version": version, "entries": score, "scoreEntries": score,
            "reviewOnlyEntries": review}


def find_risk_entry(taxonomy, code):
    return next((entry for entry in taxonomy["entries"] if entry["code"] == code), None) if code else None


def resolve_primary_item(entry, task_type):
    by_task = entry.get("primaryItemsByTask") or {}
    return by_task.get(task_type) or by_task.get("all") or entry.get("primaryItem")


def normalize_risk_item(risk, taxonomy):
    entry = find_risk_entry(taxonomy, risk.get("risk_code"))
    if entry is None and risk.get("risk_code"):
        entry = find_risk_entry(taxonomy, "OTHER_ISSUE")
    if entry is None:
        return risk
    return {**risk, "risk_code": entry["code"], "risk_category": entry["level"],
            "level": entry["level"], "title": entry["title"],
            "description": risk.get("description") or entry["description"]}

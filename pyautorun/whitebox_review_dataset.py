"""Read and update human review dashboard datasets in Python."""

from datetime import datetime, timezone
import json
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import RLock


FILES = {"human_rating_gap_analysis": "human_rating_gap_analyses.jsonl",
         "risk_review_calibration": "risk_review_calibrations.jsonl",
         "item_review_calibration": "item_review_calibrations.jsonl"}
_WRITE_LOCK = RLock()


def _path(root, kind):
    return Path(root) / "datasets" / FILES[kind]


def read_dataset(root, kind, task_names=None):
    path = _path(root, kind)
    if not path.is_file():
        return {"items": [], "skippedRows": 0}
    items = []
    skipped = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except ValueError:
            skipped += 1
            continue
        if not isinstance(item, dict) or item.get("type") != kind:
            skipped += 1
            continue
        item = dict(item)
        task_id = item.get("taskId")
        if not isinstance(task_id, int):
            skipped += 1
            continue
        item["caseName"] = item.get("caseName") or (task_names or {}).get(task_id) or f"Task {task_id}"
        item["manualAnalysisStatus"] = "analyzed" if item.get("manualAnalysisStatus") == "analyzed" else "pending"
        if item["manualAnalysisStatus"] != "analyzed":
            item.pop("manualAnalyzedAt", None)
        items.append(item)
    return {"items": items, "skippedRows": skipped}


def append_dataset(root, kind, item):
    path = _path(root, kind)
    with _WRITE_LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"type": kind, **item}, ensure_ascii=False) + "\n")


def replace_dataset_samples(root, kind, match, sample=None):
    with _WRITE_LOCK:
        return _replace_dataset_samples(root, kind, match, sample)


def _replace_dataset_samples(root, kind, match, sample=None):
    path = _path(root, kind)
    rows = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []
    kept = []
    for line in rows:
        try:
            row = json.loads(line)
        except ValueError:
            kept.append(line)
            continue
        if not isinstance(row, dict) or any(row.get(key) != value for key, value in match.items()):
            kept.append(line)
    if sample is not None:
        kept.append(json.dumps({"type": kind, **sample}, ensure_ascii=False))
    if kept:
        _rewrite(path, kept)
    else:
        path.unlink(missing_ok=True)


def _rewrite(path, lines):
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write("\n".join(lines).rstrip("\n") + "\n")
    temporary.replace(path)


def update_manual_status(root, kind, identifiers, status):
    with _WRITE_LOCK:
        return _update_manual_status(root, kind, identifiers, status)


def _update_manual_status(root, kind, identifiers, status):
    if status not in ("pending", "analyzed"):
        raise ValueError("status must be one of pending, analyzed")
    if not isinstance(identifiers, list) or not identifiers:
        raise ValueError("items must be a non-empty array")
    for item in identifiers:
        task_id = item.get("taskId") if isinstance(item, dict) else item
        risk_id = item.get("riskId") if isinstance(item, dict) else None
        if not isinstance(task_id, int) or task_id <= 0 or (kind == "risk_review_calibration" and
                (not isinstance(risk_id, int) or risk_id <= 0)):
            raise ValueError("items must contain positive taskId and riskId integers")
    path = _path(root, kind)
    if not path.is_file():
        return {"updated": 0, "missing": identifiers,
                **({"skipped": []} if kind == "risk_review_calibration" else {})}
    requested = {(item["taskId"], item.get("riskId")) if isinstance(item, dict) else (item, None)
                 for item in identifiers}
    found = set()
    skipped = []
    updated = 0
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    output = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            output.append(line)
            continue
        if not isinstance(row, dict):
            output.append(line)
            continue
        key = (row.get("taskId"), row.get("riskId") if kind == "risk_review_calibration" else None)
        if row.get("type") != kind or key not in requested:
            output.append(line)
            continue
        found.add(key)
        if kind == "risk_review_calibration" and (row.get("humanReview") or {}).get(
                "agreeWithResultLevel", (row.get("humanReview") or {}).get("agree")) is not False:
            skipped.append({"taskId": key[0], "riskId": key[1], "reason": "not_disagreed"})
            output.append(line)
            continue
        row["manualAnalysisStatus"] = status
        if status == "analyzed":
            row["manualAnalyzedAt"] = now
        else:
            row.pop("manualAnalyzedAt", None)
        output.append(json.dumps(row, ensure_ascii=False))
        updated += 1
    _rewrite(path, output)
    missing = [item for item in identifiers if ((item["taskId"], item.get("riskId"))
               if isinstance(item, dict) else (item, None)) not in found]
    if kind == "human_rating_gap_analysis":
        missing = [{"taskId": item} for item in missing]
    result = {"updated": updated, "missing": missing}
    if kind == "risk_review_calibration":
        result["skipped"] = skipped
    return result


def query_dataset(root, kind, query, task_names=None, task_created=None):
    dataset = read_dataset(root, kind, task_names)
    items = dataset["items"]
    keyword = query.get("keyword", "").lower().strip()
    selected = []
    for item in items:
        if query.get("manualAnalysisStatus") and item["manualAnalysisStatus"] != query["manualAnalysisStatus"]:
            continue
        if keyword and keyword not in " ".join(str(item.get(key) or "") for key in
                                           ("taskId", "testCaseId", "caseName")).lower():
            continue
        if kind == "human_rating_gap_analysis":
            if query.get("manualRating") and item.get("manualRating") != query["manualRating"]:
                continue
            if query.get("primaryConclusion") and item.get("primaryConclusion") != query["primaryConclusion"]:
                continue
            if query.get("from") and (not item.get("reviewedAt") or item["reviewedAt"] < query["from"]):
                continue
            if query.get("to") and (not item.get("reviewedAt") or item["reviewedAt"] > query["to"]):
                continue
        else:
            agreement = (item.get("humanReview") or {}).get("agreeWithResultLevel",
                        (item.get("humanReview") or {}).get("agree"))
            if query.get("agreement") == "agreed" and agreement is not True:
                continue
            if query.get("agreement") == "disagreed" and agreement is not False:
                continue
        selected.append(item)
    if kind == "human_rating_gap_analysis":
        selected.sort(key=lambda row: (row.get("reviewedAt") or "", row["taskId"]), reverse=True)
    else:
        selected.sort(key=lambda row: ((task_created or {}).get(row["taskId"], ""), row["taskId"]),
                      reverse=True)
    page = int(query.get("page", 1))
    size = int(query.get("pageSize", 20 if kind == "human_rating_gap_analysis" else 100))
    if page < 1 or size < 1 or size > (100 if kind == "human_rating_gap_analysis" else 500):
        raise ValueError("page and pageSize must be positive integers")
    return {"success": True, "page": page, "pageSize": size, "total": len(selected),
            "skippedRows": dataset["skippedRows"], "items": selected[(page - 1) * size:page * size]}

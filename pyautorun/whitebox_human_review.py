"""Accept manual whitebox reviews and persist recalculated results in Python."""

from datetime import datetime, timezone
import json
from pathlib import Path

from .whitebox_review_dataset import append_dataset, replace_dataset_samples
from .whitebox_review_score import apply_human_review_recalculation


LEVELS = {"L1", "L2", "L3", "L4", "L5", "L6"}
RISK_LEVELS = {"high", "medium", "low", "none"}


def _positive(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def validate_review(payload, result):
    if not isinstance(payload, dict):
        raise ValueError("Request body must be an object")
    if payload.get("manualLevel") not in LEVELS:
        raise ValueError("manualLevel must be one of L1, L2, L3, L4, L5, L6")
    for key in ("reviewer", "overallComment"):
        if key in payload and not isinstance(payload[key], str):
            raise ValueError(f"{key} must be a string")
    for field, id_key, target in (("itemReviews", "itemId", "human_review_items"),
                                  ("riskReviews", "riskId", "risks")):
        reviews = payload.get(field, [])
        if not isinstance(reviews, list):
            raise ValueError(f"{field} must be an array")
        seen = set()
        ids = {item.get("id", index + 1) for index, item in enumerate(result.get(target) or [])
               if isinstance(item, dict)}
        for index, item in enumerate(reviews):
            if not isinstance(item, dict) or not _positive(item.get(id_key)):
                raise ValueError(f"{field}[{index}].{id_key} is required or invalid")
            if item[id_key] in seen:
                raise ValueError(f"{field}[{index}].{id_key} is duplicated")
            seen.add(item[id_key])
            if item[id_key] not in ids:
                raise ValueError(f"{field}[{index}].{id_key} does not match result {target}")
            if not isinstance(item.get("agree"), bool):
                raise ValueError(f"{field}[{index}].agree is required or invalid")
            if item["agree"] is False:
                if not isinstance(item.get("reason"), str) or not item["reason"].strip():
                    raise ValueError(f"{field}[{index}].reason is required when agree is false")
                if field == "riskReviews" and item.get("correctedLevel") not in RISK_LEVELS:
                    raise ValueError(f"{field}[{index}].correctedLevel is required when agree is false")
    return payload


def _auto_rating(score):
    if score == 100:
        return "L6"
    if score >= 90:
        return "L5"
    if score >= 80:
        return "L4"
    if score >= 60:
        return "L3"
    return "L2"


def _rating_gap(level, score):
    if level == "L1" and score >= 70:
        return "manual=L1 autoScore>=70"
    if level == "L2" and score >= 80:
        return "manual=L2 autoScore>=80"
    return None


def _write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def submit_human_review(service, task_id, payload):
    record = service.store.get_remote(task_id)
    if not record:
        return 404, {"success": False, "taskId": task_id, "message": "Remote task not found"}
    if record["status"] != "completed":
        return 409, {"success": False, "taskId": task_id, "status": record["status"],
                     "message": "Remote task is not completed yet"}
    case_dir = Path(record["caseDir"])
    result_path = case_dir / "outputs" / "result.json"
    try:
        result = json.loads(result_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return 404, {"success": False, "taskId": task_id, "message": "Result file not found"}
    try:
        validate_review(payload, result)
    except ValueError as error:
        return 400, {"success": False, "taskId": task_id, "message": str(error)}
    reviewed_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    revised = result
    recalculation = None
    if payload.get("itemReviews") or payload.get("riskReviews"):
        try:
            revised, recalculation = apply_human_review_recalculation(result, payload, reviewed_at)
        except ValueError as error:
            return 409, {"success": False, "taskId": task_id, "message": str(error)}
    score = (revised.get("overall_conclusion") or {}).get("total_score")
    if not isinstance(score, (int, float)):
        return 409, {"success": False, "taskId": task_id,
                     "message": "overall_conclusion.total_score is required for manual rating gap analysis"}
    # Persist datasets from the original result so the calibration sample keeps the reviewed evidence.
    review_items = {item.get("id", index + 1): item for index, item in enumerate(
        result.get("human_review_items") or []) if isinstance(item, dict)}
    risks = {item.get("id", index + 1): item for index, item in enumerate(
        result.get("risks") or []) if isinstance(item, dict)}
    summary_text = " | ".join(str(value) for value in (
        (result.get("report_meta") or {}).get("unit_name"),
        (result.get("basic_info") or {}).get("task_type")) if value)
    comment = payload.get("overallComment") or ""
    for item in payload.get("itemReviews") or []:
        append_dataset(service.review_root, "item_review_calibration", {
            "taskId": task_id, "testCaseId": record.get("testCaseId"), "itemId": item["itemId"],
            "taskSummary": summary_text, "resultReviewItem": review_items[item["itemId"]],
            "humanReview": {"agree": item["agree"], "reason": item.get("reason"),
                            "overallComment": comment or None}})
    for item in payload.get("riskReviews") or []:
        append_dataset(service.review_root, "risk_review_calibration", {
            "taskId": task_id, "testCaseId": record.get("testCaseId"), "riskId": item["riskId"],
            "taskSummary": summary_text, "resultRisk": risks[item["riskId"]],
            "humanReview": {"agree": item["agree"], "correctedLevel": item.get("correctedLevel"),
                            "reason": item.get("reason"), "overallComment": comment or None}})
    if recalculation is not None:
        _write_json(result_path, revised)
        service.store.upsert_remote(task_id, "completed", score=score,
                                    hardGateTriggered=(revised.get("overall_conclusion") or {}).get(
                                        "hard_gate_triggered"))
    gap_rule = _rating_gap(payload["manualLevel"], score)
    manual = {"taskId": task_id, "testCaseId": record.get("testCaseId"),
              "caseName": (revised.get("basic_info") or {}).get("case_name") or record.get("testCaseName"),
              "reviewedAt": reviewed_at, "reviewer": payload.get("reviewer"),
              "manualRating": payload["manualLevel"], "basis": comment.strip(),
              "autoScore": score, "autoRating": _auto_rating(score),
              "gapQualified": bool(gap_rule), "gapRule": gap_rule}
    rating_dir = case_dir / "human-rating"
    _write_json(rating_dir / "manual-rating.json", manual)
    if gap_rule:
        service.schedule_gap_analysis(case_dir, manual, revised)
        message = "人工评级已接收，评分差异较大，差异原因分析已转入后台执行。"
    else:
        _write_json(rating_dir / "analysis-skipped.json", {**manual, "analysisStatus": "skipped",
                                                              "skipReason": "未达到差异分析阈值。"})
        (rating_dir / "analysis.json").unlink(missing_ok=True)
        replace_dataset_samples(service.review_root, "human_rating_gap_analysis", {"taskId": task_id})
        message = "人工评级已接收，未达到差异分析阈值。"
    risks_reviewed = payload.get("riskReviews") or []
    summary = {"itemReviewCount": len(payload.get("itemReviews") or []),
               "riskReviewCount": len(risks_reviewed),
               "riskAgreementCount": sum(item["agree"] is True for item in risks_reviewed),
               "riskDisagreementCount": sum(item["agree"] is False for item in risks_reviewed),
               "datasetItemCount": len(payload.get("itemReviews") or []) + len(risks_reviewed),
               "hasOverallComment": bool(comment.strip()), "manualLevel": payload["manualLevel"],
               "autoScore": score, "autoRating": _auto_rating(score), "gapQualified": bool(gap_rule),
               "analysisStatus": "completed" if gap_rule else "skipped"}
    if recalculation and recalculation["scoreRecalculationApplied"]:
        summary.update(recalculation)
    return 200, {"success": True, "taskId": task_id, "status": "completed", "summary": summary,
                 "message": ("人工复核结果已接收，结果分数已重新计算。" if recalculation and
                             recalculation["scoreRecalculationApplied"] else "人工复核结果已接收。") + message}

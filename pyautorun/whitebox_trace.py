"""Read agent trace artifacts for the Python whitebox dashboard."""

import json
from pathlib import Path


def _artifact(record):
    if not record or not record.get("caseDir"):
        return None
    path = Path(record["caseDir"]) / "outputs" / "agent-trace.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except FileNotFoundError:
        return None


def trace_summary(record):
    report = _artifact(record)
    if report is None:
        return {"success": True, "taskId": record["taskId"], "traceAvailable": False,
                "source": "artifact", "rawAvailable": False}
    summary = dict(report)
    runs = []
    for run in report.get("runs") or []:
        if not isinstance(run, dict):
            continue
        item = {key: value for key, value in run.items() if key not in
                ("prompt", "assistantText", "outputFileText", "opencodeMessages")}
        item["rawAvailable"] = True
        item["attempts"] = [{key: value for key, value in attempt.items() if key not in
                             ("prompt", "assistantText", "outputFileText")}
                            for attempt in item.get("attempts") or [] if isinstance(attempt, dict)]
        item["events"] = [{**{key: value for key, value in event.items() if key != "rawPayload"},
                           "hasRawPayload": "rawPayload" in event or event.get("hasRawPayload") is True}
                          for event in item.get("events") or [] if isinstance(event, dict)]
        runs.append(item)
    summary["runs"] = runs
    return {"success": True, "taskId": record["taskId"], "traceAvailable": True,
            "source": "artifact", "report": summary, "rawAvailable": True}


def trace_run_raw(record, run_id):
    report = _artifact(record) or {}
    run = next((item for item in report.get("runs") or [] if isinstance(item, dict) and
                item.get("id") == run_id), None)
    if run is None:
        return None
    return {"success": True, "taskId": record["taskId"], "traceRunId": run_id,
            **{key: run[key] for key in ("prompt", "assistantText", "outputFileText", "opencodeMessages")
               if key in run}}


def trace_event_raw(record, event_id):
    report = _artifact(record) or {}
    for run in report.get("runs") or []:
        for event in run.get("events") or []:
            if isinstance(event, dict) and event.get("id") == event_id:
                return {"success": True, "taskId": record["taskId"],
                        "traceEventId": event_id, "rawPayload": event.get("rawPayload")}
    return None

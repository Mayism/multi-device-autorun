"""Python HTTP entry for remote whitebox evaluation and task lookup."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import threading
from urllib.parse import parse_qs, unquote, urlsplit
from uuid import uuid4

from .whitebox_remote import run_remote_task, validate_remote_task
from .whitebox_review_dataset import query_dataset, update_manual_status
from .whitebox_dashboard import filter_tasks, negative_results, summary as dashboard_summary
from .whitebox_consistency import merge_consistency_patch
from .whitebox_cross_device import (cases_page, related_tasks, risk_review_page,
                                    rule_violations_page)
from .whitebox_gap import run_gap_analysis
from .whitebox_human_review import submit_human_review
from .whitebox_review_dataset import replace_dataset_samples
from .whitebox_service_stats import build_rule_stats, extract_rule_violations
from .whitebox_trace import trace_event_raw, trace_run_raw, trace_summary
from .whitebox_service_store import WhiteboxServiceStore


RESULT_ROUTE = re.compile(r"/score/remote-tasks/(\d+)/result(/raw)?$")
LOG_ROUTE = re.compile(r"/dashboard/tasks/(\d+)/logs$")
HUMAN_REVIEW_ROUTE = re.compile(r"/score/remote-tasks/(\d+)/human-review$")
TRACE_ROUTE = re.compile(r"/dashboard/tasks/(\d+)/agent-trace$")
TRACE_RUN_ROUTE = re.compile(r"/dashboard/tasks/(\d+)/agent-trace/runs/([^/]+)/raw$")
TRACE_EVENT_ROUTE = re.compile(r"/dashboard/tasks/(\d+)/agent-trace/events/([^/]+)/raw$")
CONSISTENCY_ROUTE = re.compile(r"/score/consistency-tasks/([^/]+)$")


def _task_ids(query):
    raw = query.get("taskIds", [""])[0]
    values = raw.split(",")
    if not 1 <= len(values) <= 50 or any(not item.strip().isdigit() or int(item) <= 0 for item in values):
        raise ValueError("Invalid query parameter: taskIds must be comma-separated positive integers")
    return [int(item.strip()) for item in values]


def _utc(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat().replace("+00:00", "Z")


def _status_category(status):
    if status in ("preparing",):
        return "received"
    if status in ("queued", "running", "completed"):
        return status
    return "failed"


class WhiteboxApiService:
    def __init__(self, root, *, evaluator=run_remote_task, concurrency=3, recover=True,
                 review_root=None, gap_analyzer=run_gap_analysis):
        self.store = WhiteboxServiceStore(root)
        self.review_root = Path(review_root or os.environ.get("HUMAN_REVIEW_EVIDENCE_ROOT") or
                                Path.home() / ".hmos-score-agent" / "human-review-evidences")
        self.evaluator = evaluator
        self.gap_analyzer = gap_analyzer
        self.pool = ThreadPoolExecutor(max_workers=max(1, concurrency), thread_name_prefix="whitebox")
        self.active = set()
        self.lock = threading.Lock()
        if recover:
            for record in self.store.list_remote():
                if record["status"] in ("preparing", "queued", "running") and record.get("caseDir"):
                    source = Path(record["caseDir"]) / "inputs" / "remote-task.json"
                    try:
                        task = json.loads(source.read_text(encoding="utf-8"))
                        self._submit(task, Path(record["caseDir"]))
                    except (OSError, ValueError):
                        self.store.upsert_remote(record["taskId"], "failed", error="remote task recovery failed")

    def _submit(self, task, case_dir):
        task_id = task["taskId"]
        with self.lock:
            if task_id in self.active:
                raise ValueError(f"remote task {task_id} is already running")
            self.active.add(task_id)
        def work():
            self.store.upsert_remote(task_id, "running")
            try:
                result = self.evaluator(task, local_case_root=self.store.root, case_dir=case_dir)
                data = json.loads(Path(result["resultPath"]).read_text(encoding="utf-8"))
                conclusion = data.get("overall_conclusion") or {}
                basic = data.get("basic_info") or {}
                self.store.upsert_remote(task_id, "completed", resultAvailable=True,
                    caseName=basic.get("case_name") or task["testCase"]["name"],
                    taskType=basic.get("task_type") or task["testCase"]["type"],
                    score=conclusion.get("total_score"),
                    hardGateTriggered=conclusion.get("hard_gate_triggered"),
                    risks=[{key: risk[key] for key in ("level", "title") if key in risk}
                           for risk in data.get("risks", []) if isinstance(risk, dict)])
                try:
                    self.store.write_rule_violations(task_id, str(task_id), task["testCase"]["id"],
                        task["testCase"]["name"], int(datetime.now(timezone.utc).timestamp() * 1000),
                        extract_rule_violations(data))
                except Exception as index_error:
                    self.store.upsert_remote(task_id, "completed", resultError=str(index_error))
            except Exception as error:
                self.store.upsert_remote(task_id, "failed", error=str(error), resultAvailable=False)
            finally:
                with self.lock:
                    self.active.discard(task_id)
        self.pool.submit(work)

    def accept(self, task):
        validate_remote_task(task)
        existing = self.store.get_remote(task["taskId"])
        if existing and existing["status"] in ("preparing", "queued", "running"):
            raise ValueError(f'remote task {task["taskId"]} is already running')
        name = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + \
               f'_case_{task["taskId"]}_{uuid4().hex[:8]}'
        case_dir = self.store.root / name
        (case_dir / "inputs").mkdir(parents=True, exist_ok=True)
        (case_dir / "inputs" / "remote-task.json").write_text(
            json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")
        self.store.upsert_remote(task["taskId"], "queued", caseDir=str(case_dir),
            testCaseId=task["testCase"].get("id"), testCaseName=task["testCase"]["name"],
            testCaseType=task["testCase"]["type"], remoteTaskFile="inputs/remote-task.json",
            caseName=None, taskType=None, score=None, hardGateTriggered=None,
            resultAvailable=False, resultError=None, error=None, risks=[])
        self._submit(task, case_dir)
        return {"success": True, "taskId": task["taskId"],
                "message": "任务接收成功，结果将通过 callback 返回"}

    def statuses(self, ids):
        items = []
        for task_id in ids:
            record = self.store.get_remote(task_id)
            if not record:
                items.append({"taskId": task_id, "status": "missing", "resultAvailable": False,
                              "message": "Remote task not found"})
                continue
            items.append({key: record[key] for key in ("taskId", "status", "createdAt", "updatedAt",
                          "testCaseId", "testCaseName", "error") if key in record} |
                         {"resultAvailable": record["status"] == "completed"})
        return {"success": True, "items": items}

    def result(self, task_id, raw=False):
        record = self.store.get_remote(task_id)
        if not record:
            return 404, {"success": False, "taskId": task_id, "message": "Remote task not found"}
        if record["status"] != "completed":
            terminal = record["status"] in ("failed", "timed_out")
            return 409, {"success": False, "taskId": task_id, "status": record["status"],
                         "message": "Remote task execution failed" if terminal else "Result is not available yet",
                         "resultAvailable": False, "terminal": terminal,
                         **({"error": record["error"]} if record.get("error") else {})}
        path = Path(record["caseDir"]) / "outputs" / "result.json"
        try:
            content = path.read_text(encoding="utf-8")
            data = json.loads(content)
        except FileNotFoundError:
            return 404, {"success": False, "taskId": task_id, "status": "completed",
                         "message": "Result file not found"}
        if raw:
            return 200, content
        if isinstance(data, dict):
            data.pop("testExecution", None)
        return 200, {"success": True, "taskId": task_id, "status": "completed", "resultData": data}

    def delete(self, ids):
        deleted = []
        for task_id in ids:
            record = self.store.get_remote(task_id)
            if not record:
                continue
            if record["status"] in ("preparing", "queued", "running"):
                raise ValueError(f"remote task {task_id} is still running")
            if record.get("caseDir"):
                path = Path(record["caseDir"]).resolve()
                if not path.is_relative_to(self.store.root):
                    raise ValueError("refusing to delete task artifacts outside case root")
                shutil.rmtree(path, ignore_errors=True)
            if self.store.delete_remote(task_id):
                deleted.append(task_id)
        return {"success": True, "deletedTaskIds": deleted}

    def dashboard_items(self):
        records = self.store.list_remote()
        items = [{"taskId": row["taskId"], "testCaseId": row.get("testCaseId"),
                  "name": row.get("caseName") or row.get("testCaseName") or f'Task {row["taskId"]}',
                  "status": row["status"], "statusCategory": _status_category(row["status"]),
                  "taskType": row.get("taskType") or row.get("testCaseType") or "",
                  "score": row.get("score"), "hardGateTriggered": row.get("hardGateTriggered"),
                  "createdAt": _utc(row["createdAt"]), "updatedAt": _utc(row["updatedAt"]),
                  "resultAvailable": row["status"] == "completed", "risks": row.get("risks") or [],
                  **({"error": row["error"]} if row.get("error") else {})}
                 for row in records]
        return items

    def dashboard_tasks(self, query):
        query = {key: value[0] for key, value in query.items()}
        items = filter_tasks(self.dashboard_items(), query)
        sort_by = query.get("sortBy", "createdAt")
        reverse = query.get("sortOrder", "desc") != "asc"
        if sort_by in ("createdAt", "updatedAt", "score", "taskId"):
            items.sort(key=lambda item: (item[sort_by] is None, item[sort_by]), reverse=reverse)
        page = max(1, int(query.get("page", "1")))
        size = min(100, max(1, int(query.get("pageSize", "20"))))
        return {"success": True, "page": page, "pageSize": size,
                "total": len(items), "items": items[(page - 1) * size:page * size]}

    def dashboard_log(self, task_id, tail_bytes):
        row = self.store.get_remote(task_id)
        if not row:
            return 404, {"success": False, "message": "Task not found"}
        log = Path(row["caseDir"]) / "logs" / "run.log" if row.get("caseDir") else None
        content = b""
        truncated = False
        if log and log.is_file():
            with log.open("rb") as stream:
                stream.seek(0, 2)
                size = stream.tell()
                truncated = size > tail_bytes
                stream.seek(max(0, size - tail_bytes))
                content = stream.read()
        return 200, {"success": True, "taskId": task_id, "status": row["status"],
                     "logPath": "logs/run.log", "available": bool(log and log.is_file()),
                     "truncated": truncated, "tailBytes": tail_bytes,
                     "content": content.decode("utf-8", errors="replace")}

    def schedule_gap_analysis(self, case_dir, manual, result):
        def work():
            try:
                analysis = self.gap_analyzer(case_dir, manual, result)
                artifact = Path(case_dir) / "human-rating" / "analysis.json"
                artifact.parent.mkdir(parents=True, exist_ok=True)
                artifact.write_text(json.dumps({**manual, "analysis": analysis}, ensure_ascii=False, indent=2) + "\n",
                                    encoding="utf-8")
                replace_dataset_samples(self.review_root, "human_rating_gap_analysis",
                    {"taskId": manual["taskId"]}, {"taskId": manual["taskId"],
                        "testCaseId": manual.get("testCaseId"), "caseName": manual.get("caseName"),
                        "reviewedAt": manual["reviewedAt"], "reviewer": manual.get("reviewer"),
                        "manualRating": manual["manualRating"], "manualBasis": manual["basis"],
                        "autoScore": manual["autoScore"], "autoRating": manual["autoRating"],
                        "gapRule": manual["gapRule"],
                        "primaryConclusion": analysis["primaryConclusion"],
                        "confidence": analysis["confidence"], "reasonSummary": analysis["reasonSummary"],
                        "humanNeedsImprovement": analysis["humanRatingReview"]["needsImprovement"],
                        "scoringNeedsImprovement": analysis["scoringSystemReview"]["needsImprovement"],
                        "recommendedActions": analysis["recommendedActions"],
                        "artifactPath": "human-rating/analysis.json"})
            except Exception as error:
                self.store.upsert_remote(manual["taskId"], "completed", resultError=str(error))
        self.pool.submit(work)

    def close(self):
        self.pool.shutdown(wait=True)

    def consistency_tasks(self):
        records = self.store.list_consistency()
        for item in records:
            if isinstance(item.get("sourceTask"), dict):
                continue
            original_id = item.get("originalTaskId")
            if not isinstance(original_id, int) or original_id <= 0:
                continue
            remote = self.store.get_remote(original_id)
            if not remote or not remote.get("caseDir"):
                continue
            path = Path(remote["caseDir"]) / "inputs" / "remote-task.json"
            try:
                item["sourceTask"] = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
        return records

    def delete_consistency_task(self, identity):
        item = next((item for item in self.store.list_consistency() if item["id"] == identity), None)
        if item is None:
            return False
        ids = {run["taskId"] for runs in [item.get("runs") or []] + [
            entry.get("runs") or [] for entry in item.get("analysisHistory") or [] if isinstance(entry, dict)]
            for run in runs if isinstance(run, dict) and isinstance(run.get("taskId"), int)}
        for task_id in ids:
            self.delete([task_id])
        return self.store.delete_consistency(identity)


def make_handler(service):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, value, *, raw=False):
            body = value.encode("utf-8") if raw else json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "*"))
            self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 2 * 1024 * 1024:
                raise ValueError("request body exceeds 2 MB")
            return json.loads(self.rfile.read(length)) if length else {}

        def _handle(self):
            parsed = urlsplit(self.path)
            path = unquote(parsed.path)
            query = parse_qs(parsed.query)
            method = self.command
            if method == "OPTIONS":
                self._send(204, {})
            elif method == "GET" and path == "/health":
                self._send(200, {"ok": True})
            elif method == "POST" and path == "/score/run-remote-task":
                self._send(200, service.accept(self._body()))
            elif method == "GET" and path == "/score/remote-tasks/status":
                self._send(200, service.statuses(_task_ids(query)))
            elif method == "DELETE" and path == "/score/remote-tasks":
                self._send(200, service.delete(_task_ids(query)))
            elif method == "GET" and (match := RESULT_ROUTE.fullmatch(path)):
                code, value = service.result(int(match[1]), raw=bool(match[2]))
                self._send(code, value, raw=bool(match[2]) and code == 200)
            elif method == "POST" and (match := HUMAN_REVIEW_ROUTE.fullmatch(path)):
                code, value = submit_human_review(service, int(match[1]), self._body())
                self._send(code, value)
            elif method == "GET" and path == "/dashboard/tasks":
                self._send(200, service.dashboard_tasks(query))
            elif method == "GET" and (match := LOG_ROUTE.fullmatch(path)):
                tail = int(query.get("tailBytes", ["65536"])[0])
                if not 1 <= tail <= 1048576:
                    raise ValueError("tailBytes must be a positive integer")
                code, value = service.dashboard_log(int(match[1]), tail)
                self._send(code, value)
            elif method == "GET" and (match := TRACE_ROUTE.fullmatch(path)):
                record = service.store.get_remote(int(match[1]))
                self._send(200, trace_summary(record)) if record else self._send(
                    404, {"success": False, "message": "Task not found"})
            elif method == "GET" and (match := TRACE_RUN_ROUTE.fullmatch(path)):
                record = service.store.get_remote(int(match[1]))
                value = trace_run_raw(record, match[2]) if record else None
                self._send(200, value) if value else self._send(404, {
                    "success": False, "message": "Agent trace run not found"})
            elif method == "GET" and (match := TRACE_EVENT_ROUTE.fullmatch(path)):
                record = service.store.get_remote(int(match[1]))
                value = trace_event_raw(record, match[2]) if record else None
                self._send(200, value) if value else self._send(404, {
                    "success": False, "message": "Agent trace event not found"})
            elif method == "GET" and path == "/dashboard/summary":
                flat = {key: value[0] for key, value in query.items()}
                tasks = filter_tasks(service.dashboard_items(),
                                     {key: flat[key] for key in ("from", "to") if key in flat})
                self._send(200, {"success": True,
                    "generatedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                    **dashboard_summary(tasks)})
            elif method == "GET" and path == "/dashboard/analysis/negative-results":
                flat = {key: value[0] for key, value in query.items()}
                tasks = filter_tasks(service.dashboard_items(),
                    {key: flat[key] for key in ("from", "to", "taskType") if key in flat})
                self._send(200, {"success": True,
                    **negative_results(tasks, service.store.list_rule_violations(),
                                       float(flat.get("scoreThreshold", "70")))})
            elif method == "GET" and path == "/score/rule-violation-stats":
                self._send(200, build_rule_stats(service.store.list_rule_violations(),
                                                 {key: value[0] for key, value in query.items()}))
            elif method == "GET" and path == "/dashboard/tasks/status-counts":
                counts = {"received": 0, "queued": 0, "running": 0, "completed": 0, "failed": 0}
                for row in service.store.list_remote():
                    counts[_status_category(row["status"])] += 1
                self._send(200, {"success": True, "statusCounts": counts})
            elif method == "GET" and path.startswith("/dashboard/cross-device/"):
                flat = {key: value[0] for key, value in query.items()}
                tasks = related_tasks(service.store.list_remote(), service.dashboard_items())
                if path == "/dashboard/cross-device/cases":
                    self._send(200, cases_page(tasks, flat))
                elif path == "/dashboard/cross-device/rule-violations":
                    self._send(200, rule_violations_page(tasks, flat))
                elif path == "/dashboard/cross-device/risk-review-calibrations":
                    self._send(200, risk_review_page(tasks, flat, service.review_root))
                else:
                    self._send(404, {"success": False, "message": "Not found"})
            elif method == "GET" and path in ("/dashboard/analysis/human-rating-gaps",
                                                "/dashboard/analysis/risk-review-calibrations"):
                kind = ("human_rating_gap_analysis" if path.endswith("human-rating-gaps") else
                        "risk_review_calibration")
                tasks = service.dashboard_items()
                flat = {key: value[0] for key, value in query.items()}
                self._send(200, query_dataset(service.review_root, kind, flat,
                    {item["taskId"]: item["name"] for item in tasks},
                    {item["taskId"]: item["createdAt"] for item in tasks}))
            elif method == "POST" and path in (
                    "/dashboard/analysis/human-rating-gaps/manual-analysis-status",
                    "/dashboard/analysis/risk-review-calibrations/manual-analysis-status"):
                kind = ("human_rating_gap_analysis" if "human-rating-gaps" in path else
                        "risk_review_calibration")
                body = self._body()
                identifiers = body.get("taskIds") if kind == "human_rating_gap_analysis" else body.get("items")
                self._send(200, {"success": True, **update_manual_status(
                    service.review_root, kind, identifiers, body.get("status"))})
            elif method == "GET" and path == "/score/consistency-tasks":
                self._send(200, {"success": True, "items": service.consistency_tasks()})
            elif method == "PUT" and path == "/score/consistency-tasks":
                self._send(200, {"success": True, "items": service.store.replace_consistency(self._body().get("items"))})
            elif (match := CONSISTENCY_ROUTE.fullmatch(path)):
                identity = match[1]
                if method == "PUT":
                    item = self._body()
                    if not isinstance(item, dict) or item.get("id") != identity:
                        raise ValueError("consistency task id mismatch")
                    self._send(200, {"success": True, "item": service.store.upsert_consistency(item)})
                elif method == "POST":
                    existing = next((item for item in service.store.list_consistency()
                                     if item["id"] == identity), None)
                    if existing is None:
                        self._send(404, {"success": False, "message": "Consistency task not found"})
                    else:
                        self._send(200, {"success": True, "item": service.store.upsert_consistency(
                            merge_consistency_patch(existing, self._body()))})
                elif method == "DELETE":
                    deleted = service.delete_consistency_task(identity)
                    self._send(200 if deleted else 404,
                               {"success": True} if deleted else
                               {"success": False, "message": "Consistency task not found"})
                else:
                    self._send(404, {"success": False, "message": "Not found"})
            else:
                self._send(404, {"success": False, "message": "Not found"})

        def do_GET(self):
            self._safe_handle()

        def do_POST(self):
            self._safe_handle()

        def do_PUT(self):
            self._safe_handle()

        def do_DELETE(self):
            self._safe_handle()

        def do_OPTIONS(self):
            self._safe_handle()

        def _safe_handle(self):
            try:
                self._handle()
            except (ValueError, TypeError, KeyError) as error:
                self._send(400, {"success": False, "message": str(error)})
            except Exception as error:
                self._send(500, {"success": False, "message": str(error)})
    return Handler


def main(argv=None):
    parser = argparse.ArgumentParser(description="Python whitebox HTTP API")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "3000")))
    parser.add_argument("--case-root", default=os.environ.get("LOCAL_CASE_ROOT", ".local-cases"))
    args = parser.parse_args(argv)
    service = WhiteboxApiService(args.case_root,
        concurrency=int(os.environ.get("HMOS_REMOTE_TASK_CONCURRENCY", "3")))
    server = ThreadingHTTPServer((args.host, args.port), make_handler(service))
    try:
        print(f"hmos-score-agent Python API 已启动，监听端口：{args.port}", flush=True)
        server.serve_forever()
    finally:
        server.server_close()
        service.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

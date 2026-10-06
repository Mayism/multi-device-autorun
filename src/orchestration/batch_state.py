"""Atomic batch state, safe retry lookup and interrupted-run recovery."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path

from pyautorun.orchestration.case_run import write_json
from pyautorun.runtime.usage import add_compile_usage, add_token_usage, empty_compile_usage, empty_token_usage


FINAL_STATUSES = {"completed", "failed", "timed_out", "rate_limited", "cancelled", "interrupted", "skipped"}


def _iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None


class BatchStateStore:
    def __init__(self, path, state):
        self.path = Path(path)
        self.state = state
        self.persist()

    def persist(self):
        write_json(self.path, self.state)

    def set_batch(self, values):
        self.state.update(values)
        self.state["updatedAt"] = _iso()
        self.persist()

    def set_case(self, name, values):
        self.state["cases"][name].update(values)
        self.state["cases"][name]["updatedAt"] = _iso()
        self.persist()


def _batch_dirs(output_root):
    root = Path(output_root)
    if not root.is_dir():
        return []
    result = []
    for entry in root.iterdir():
        if not entry.is_dir():
            continue
        if (entry / "batch.json").is_file():
            result.append(entry)
        else:
            result.extend(child for child in entry.iterdir() if child.is_dir() and (child / "batch.json").is_file())
    return result


def _alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except PermissionError:
        return True
    except (OSError, ValueError, TypeError):
        return False


def recover_interrupted_runs(output_root):
    recovered = []
    for root in _batch_dirs(output_root):
        batch = read_json(root / "batch.json")
        if not isinstance(batch, dict) or batch.get("status") != "running" or not isinstance(batch.get("cases"), dict):
            continue
        try:
            pid = (root / "batch.pid").read_text(encoding="utf-8").strip()
        except OSError:
            pid = ""
        if pid and _alive(pid):
            continue
        timestamp = _iso()
        results = []
        for name, state in batch["cases"].items():
            result_path = Path(state.get("resultPath") or root / name / "result.json")
            existing = read_json(result_path) or {}
            if state.get("status") in FINAL_STATUSES:
                results.append(existing or {"case": name, "status": state["status"],
                                            "tokenUsage": state.get("tokenUsage") or empty_token_usage(),
                                            "agentCompile": state.get("agentCompile") or empty_compile_usage()})
                continue
            status = "cancelled" if state.get("status") == "pending" else "interrupted"
            error = ("上次批次被中断，用例尚未开始执行" if status == "cancelled" else
                     "上次 Autorun 进程在用例完成前退出")
            state.update({"status": status, "stage": status, "error": error,
                          "finishedAt": timestamp, "updatedAt": timestamp, "recoveredAt": timestamp})
            result = {**existing, "case": name, "status": status, "error": error,
                      "startedAt": state.get("startedAt") or "", "finishedAt": timestamp,
                      "projectDir": state.get("projectDir") or "", "recoveredAt": timestamp,
                      "tokenUsage": state.get("tokenUsage") or empty_token_usage(),
                      "agentCompile": state.get("agentCompile") or empty_compile_usage()}
            if status == "interrupted":
                result["resultPath"] = str(result_path)
                write_json(result_path, result)
                write_json(result_path.parent / "state.json", {"case": name, **state})
            results.append(result)
        failed = sum(item.get("status") != "completed" for item in results)
        summary = read_json(root / "summary.json") or {}
        summary.update({"batchId": batch.get("batchId"), "targetId": batch.get("targetId"),
                        "status": "interrupted", "finishedAt": timestamp,
                        "total": sum(item.get("status") != "skipped" for item in batch["cases"].values()),
                        "completed": len(results) - failed, "failed": failed,
                        "tokenUsage": add_token_usage(*(item.get("tokenUsage") for item in results)),
                        "agentCompile": add_compile_usage(*(item.get("agentCompile") for item in results)),
                        "results": results})
        write_json(root / "summary.json", summary)
        batch.update({"status": "interrupted", "finishedAt": timestamp, "updatedAt": timestamp})
        write_json(root / "batch.json", batch)
        (root / "batch.pid").unlink(missing_ok=True)
        recovered.append(str(root))
    return recovered


def load_retry_plan(output_root, batch_id, requested_case=""):
    root = Path(output_root).resolve()
    relative = str(batch_id or "").strip().replace("\\", "/").strip("/")
    parts = Path(relative).parts
    if not relative or len(parts) > 2 or any(part in (".", "..") for part in parts) or Path(relative).is_absolute():
        raise ValueError(f"无效的重试批次 ID: {batch_id or '<empty>'}")
    source = (root / relative).resolve()
    if root not in source.parents:
        raise ValueError(f"无效的重试批次 ID: {batch_id}")
    if not (source / "batch.json").is_file() and len(parts) == 1:
        matches = [item for item in _batch_dirs(root) if item.name == relative or item.parent.name == relative]
        if len(matches) == 1:
            source = matches[0]
    batch = read_json(source / "batch.json")
    if not isinstance(batch, dict) or not isinstance(batch.get("cases"), dict):
        raise ValueError(f"重试批次不存在或 batch.json 无效: {source}")
    summary = read_json(source / "summary.json") or {}
    summary_results = {item.get("case"): item for item in summary.get("results") or [] if item.get("case")}
    previous = {}
    for name, state in batch["cases"].items():
        result_path = Path(state.get("resultPath") or source / name / "result.json")
        previous[name] = read_json(result_path) or summary_results.get(name) or {
            "case": name, "status": state.get("status") or "failed", "agentStatus": state.get("agentStatus") or "",
            "error": state.get("error") or "", "projectName": state.get("projectName") or "",
            "projectDir": state.get("projectDir") or "", "patchPath": state.get("patchPath") or "",
            "resultPath": str(result_path)}
    if requested_case:
        matches = [name for name in previous if name == requested_case] or [
            name for name in previous if name.lower() == requested_case.lower()]
        if len(matches) != 1:
            raise ValueError(f"批次 {batch_id} 中不存在唯一用例 {requested_case}")
        selected = matches
    else:
        selected = [name for name, item in previous.items()
                    if item.get("status") not in ("completed", "skipped")]
        if not selected:
            raise ValueError(f"批次 {batch_id} 没有可重试的失败或中断用例")
    return {"sourceBatchId": relative, "sourceBatchRoot": str(source),
            "requestedCaseName": selected[0] if requested_case else "",
            "selectedCaseNames": selected, "previousResults": previous}

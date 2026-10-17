"""Runtime batch state and interrupted-run recovery."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path

from pyautorun.orchestration.case_run import write_json
from pyautorun.orchestration.artifact_cleanup import cleanup_case_metadata
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
    def __init__(self, path, state, on_case_change=None):
        self.path = Path(path)
        self.state = state
        self.on_case_change = on_case_change
        self.closed = False
        self.persist()

    def persist(self):
        if not self.closed:
            write_json(self.path, self.state)

    def remove(self):
        self.closed = True
        self.path.unlink(missing_ok=True)

    def set_batch(self, values):
        self.state.update(values)
        self.state["updatedAt"] = _iso()
        self.persist()

    def set_case(self, name, values):
        self.state["cases"][name].update(values)
        self.state["cases"][name]["updatedAt"] = _iso()
        self.persist()
        if self.on_case_change:
            self.on_case_change(name, self.state["cases"][name])


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
                        **({"environment": batch["environment"]} if batch.get("environment") else {}),
                        "results": results})
        write_json(root / "summary.json", summary)
        for failure in cleanup_case_metadata(root, summary):
            print(f"[cleanup] {failure}")
        batch.update({"status": "interrupted", "finishedAt": timestamp, "updatedAt": timestamp})
        (root / "batch.pid").unlink(missing_ok=True)
        (root / "batch.json").unlink(missing_ok=True)
        recovered.append(str(root))
    return recovered

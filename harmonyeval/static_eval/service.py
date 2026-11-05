"""Independent static-assessment lifecycle, reports and isolated wheel processes."""

import asyncio
from datetime import datetime, timezone
from hashlib import sha256
from html import escape
import json
import os
from pathlib import Path
import sys
import threading
import time
from urllib.parse import urlsplit

from harmonyeval.models.compatibility import resolve_api_key
from harmonyeval.static_eval.config import plan
from harmonyeval.utils.encoding import console_print, python_utf8_environment, decode_output
from harmonyeval.utils.io import write_json
from harmonyeval.utils.processes import stop_process, watch_cancellation
from harmonyeval.static_eval.worker import scrub


def save_report(payload, root):
    write_json(root / "static-result.json", payload)
    rows = []
    for item in payload["results"]:
        link = item.get("html_path")
        label = escape(item["skill_name"] + " / " + item["check"])
        if link:
            label = '<a href="' + escape(link, quote=True) + '">' + label + '</a>'
        rows.append('<tr><td>' + label + '</td><td>' + escape(item["status"]) + '</td><td><pre>' +
                    escape(json.dumps(item.get("metrics", {}), ensure_ascii=False)) + '</pre></td><td>' + escape(item.get("error", "")) + '</td></tr>')
    page = ('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>静态评估</title>'
            '<style>body{font:15px/1.6 system-ui;margin:32px}td,th{padding:12px;border-bottom:1px solid #ddd}pre{white-space:pre-wrap}</style>'
            '<h1>Skill 静态评估</h1><p>' + escape(payload["status"]) + ' · ' + escape(payload.get("error", "")) +
            '</p><p>质量分与安全发现分别保留，不参与主评测的 L2/L3。</p><table><tr><th>Skill / 检查</th><th>执行状态</th><th>结果</th><th>错误</th></tr>' + ''.join(rows) + '</table></html>')
    (root / "index.html").write_text(page, encoding="utf-8")


async def run_check(check, skill, model, output, timeout, cancel_event=None, command=None):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    prefix = "quality_eval" if check == "quality" else "security_scan"
    for name in ("result.json", "worker.log", *(prefix + suffix for suffix in (".json", ".html", ".md"))):
        (output / name).unlink(missing_ok=True)
    request = json.dumps({"check": check, "skill": str(skill), "model": model, "output": str(output)}, ensure_ascii=False).encode("utf-8")
    secret = model["api_key"]
    environment = python_utf8_environment()
    if urlsplit(model["base_url"]).hostname in ("127.0.0.1", "localhost", "::1"):
        bypass = environment.get("no_proxy") or environment.get("NO_PROXY", "")
        environment["NO_PROXY"] = environment["no_proxy"] = ",".join(filter(None, [bypass, "127.0.0.1", "localhost", "::1"]))
    # No external toolkit imports in this parent process; isolate generic core/llm modules.
    proc = await asyncio.create_subprocess_exec(
        *(command or [sys.executable, "-m", "harmonyeval.static_eval.worker"]),
        env=environment, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, start_new_session=os.name != "nt")
    watcher = asyncio.create_task(watch_cancellation(proc, cancel_event))
    communication = asyncio.create_task(proc.communicate(request))
    failure = None
    wall_deadline, monotonic_deadline = time.time() + timeout, time.monotonic() + timeout
    try:
        while True:
            # A suspended host can advance wall time without advancing the event
            # loop's monotonic clock. Bound both and recheck after waking up.
            remaining = min(wall_deadline - time.time(), monotonic_deadline - time.monotonic())
            if remaining <= 0:
                raise asyncio.TimeoutError()
            try:
                stdout, stderr = await asyncio.wait_for(asyncio.shield(communication), min(remaining, 1))
                break
            except asyncio.TimeoutError:
                continue
    except asyncio.TimeoutError:
        failure = {"status": "timed_out", "error": f"静态评估超过 {timeout} 秒"}
        await stop_process(proc)
        stdout, stderr = await communication
    except asyncio.CancelledError:
        await stop_process(proc)
        await communication
        raise
    finally:
        await stop_process(proc)
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)
    log = (decode_output(stdout) or "") + "\n[stderr]\n" + (decode_output(stderr) or "")
    (output / "worker.log").write_text(scrub(log, secret), encoding="utf-8")
    if cancel_event is not None and cancel_event.is_set():
        return {"status": "interrupted", "error": "静态评估已中断"}
    if failure:
        return failure
    result = json.loads((output / "result.json").read_text(encoding="utf-8"))
    if result.get("status") == "completed":
        if proc.returncode != 0 or not (output / result["report"]).is_file():
            raise ValueError("静态评估进程或原始报告不完整")
    return scrub(result, secret)


async def run_static_eval(task, output, cancel_event=None, on_log=console_print):
    """Once per task, never per case/round/experiment. No dependency on main results."""
    root = Path(output)
    root.mkdir(parents=True, exist_ok=True)
    cancel_event = cancel_event or threading.Event()
    cancelled = False
    config = task["active"].get("static_eval", {})
    payload = {"schema_version": 1, "task_id": task["id"], "status": "running", "results": [],
               "started_at": datetime.now(timezone.utc).isoformat(), "error": ""}
    try:
        planned = plan(config)
        payload["plan"] = planned
        if not planned["enabled"]:
            payload["status"] = "disabled"
        elif planned["errors"]:
            raise ValueError("；".join(planned["errors"]))
        else:
            model = dict(config["model"])
            key = resolve_api_key(model)
            if not key:
                raise ValueError("静态评估模型密钥未设置")
            model["api_key"] = key
            semaphore = asyncio.Semaphore(config["concurrency"])
            payload["planned_checks"] = len(planned["skills"]) * len(config["checks"])
            save_report(payload, root)

            async def one(skill, check):
                path = Path(skill)
                name = path.name + "-" + sha256(str(path).encode("utf-8")).hexdigest()[:8]
                relative = Path(name) / check
                record = {"skill_name": path.name, "skill_path": str(path), "check": check, "status": "queued"}
                payload["results"].append(record)
                async with semaphore:
                    record.update(status="running", started_at=datetime.now(timezone.utc).isoformat())
                    save_report(payload, root)
                    if cancel_event is not None and cancel_event.is_set():
                        result = {"status": "interrupted", "error": "静态评估已中断"}
                    else:
                        on_log(f"[static_eval] {path.name} / {check}")
                        try:
                            result = await run_check(check, path, model, root / relative, config["timeout"], cancel_event)
                        except Exception as error:
                            result = {"status": "unavailable", "error": scrub(f"{type(error).__name__}: {error}", key)}
                if result.get("html"):
                    result["html_path"] = (relative / result["html"]).as_posix()
                record.update(**result, finished_at=datetime.now(timezone.utc).isoformat())
                save_report(payload, root)
            jobs = asyncio.gather(*(one(skill, check) for skill in planned["skills"] for check in config["checks"]))
            try:
                await asyncio.shield(jobs)
            except asyncio.CancelledError:
                cancel_event.set()
                await asyncio.shield(jobs)
                cancelled = True
            payload["status"] = ("interrupted" if cancel_event is not None and cancel_event.is_set() else
                                 "completed" if all(r["status"] == "completed" for r in payload["results"]) else "incomplete")
    except Exception as error:
        payload.update(status="unavailable", error=f"{type(error).__name__}: {error}")
    payload["finished_at"] = datetime.now(timezone.utc).isoformat()
    payload["results"].sort(key=lambda r: (r["skill_path"], r["check"]))
    save_report(payload, root)
    if cancelled:
        raise asyncio.CancelledError()
    return {"exitCode": 0 if payload["status"] in ("completed", "disabled") else 1,
            "status": payload["status"], "reportPath": str(root / "index.html"), "runRoot": str(root)}

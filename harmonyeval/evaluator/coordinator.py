"""Coordinate independent main/static branches at the task boundary."""

import asyncio
from datetime import datetime
from html import escape
from pathlib import Path
from uuid import uuid4
from harmonyeval.static_eval.service import run_static_eval
from harmonyeval.utils.io import write_json


def allocate_run_root(task):
    run_id = datetime.now().strftime("%Y%m%d%H%M%S") + "-" + uuid4().hex[:6]
    return Path(task["active"]["report"]["output_dir"]) / run_id


async def run_parallel(task, main_runner, cancel_event, on_log):
    root = allocate_run_root(task)
    root.mkdir(parents=True)

    async def main():
        try:
            result = await asyncio.to_thread(main_runner, task, on_log, cancel_event, root)
            return {"status": "completed" if result["exitCode"] == 0 else "incomplete", **result}
        except Exception as error:
            return {"status": "error", "exitCode": 1, "error": f"{type(error).__name__}: {error}"}

    async def static():
        try:
            return await run_static_eval(task, root / "static-eval", cancel_event, on_log)
        except Exception as error:
            return {"status": "unavailable", "exitCode": 1, "error": f"{type(error).__name__}: {error}"}

    main_result, static_result = await asyncio.gather(main(), static())
    # Persist branch results without adding static fields to case scoring or replay identities.
    summary = {"schema_version": 1, "task_id": task["id"], "main": main_result, "static_eval": static_result}
    write_json(root / "run-summary.json", summary)
    links = []
    for label, value in (("主评测", main_result), ("静态评估", static_result)):
        report = value.get("reportPath")
        title = escape(label + "：" + value["status"])
        if report:
            title = '<a href="' + escape(Path(report).relative_to(root).as_posix(), quote=True) + '">' + title + '</a>'
        links.append('<li>' + title + '<pre>' + escape(value.get("error", "")) + '</pre></li>')
    index = root / "run-summary.html"
    index.write_text('<!doctype html><meta charset="utf-8"><title>评测任务</title><h1>评测任务</h1><ul>' + ''.join(links) + '</ul>', encoding="utf-8")
    return {**main_result, "exitCode": max(main_result["exitCode"], static_result["exitCode"]),
            "status": "completed" if main_result["exitCode"] == static_result["exitCode"] == 0 else "incomplete",
            "reportPath": str(index), "runRoot": str(root), "static_eval": static_result}

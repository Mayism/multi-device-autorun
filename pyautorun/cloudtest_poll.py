"""Resume and report an existing AGC cloud-test task in Python."""

from datetime import datetime, timezone
import argparse
import json
from pathlib import Path
import time

from .cloudtest import final_status, load_config, summarize_report
from .cloudtest_client import CloudTestClient
from .cloudtest_report import fetch_task_report, write_cloudtest_html_report
from .config import load_autorun_config


FINAL_STATUSES = {3, 4, 5, 6}
STATUS_LABELS = {1: "待执行", 2: "执行中", 3: "已完成", 4: "已完成", 5: "已完成", 6: "已完成"}


def _now():
    return datetime.now(timezone.utc)


def _iso(value=None):
    return (value or _now()).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{time.time_ns()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def poll_task_group(client, task_group_id, settings, on_log=print, on_update=None, sleep=time.sleep):
    deadline = time.monotonic() + settings["taskTimeoutSec"]
    misses = 0
    last_label = ""
    current = None
    polls = 0
    while time.monotonic() < deadline:
        groups = client.list_task_groups()
        current = next((group for group in groups if str(group.get("id")) == str(task_group_id)), None)
        if current is None:
            misses += 1
            if misses >= 5:
                raise RuntimeError(f"连续 {misses} 次未在任务组列表中找到 {task_group_id}")
        else:
            misses = 0
            polls += 1
            status = current.get("status")
            label = (f"status={status}({STATUS_LABELS.get(status, '未知')}) "
                     f"resultStatus={current.get('resultStatus')} 进度 "
                     f"{current.get('processedTestTaskCount') or 0}/{current.get('taskCount') or '?'}")
            if label != last_label:
                on_log(f"任务状态: {label}")
                last_label = label
            if on_update:
                on_update(current, polls)
            if int(status or 0) in FINAL_STATUSES or int(current.get("resultStatus") or 0) > 0:
                return {"taskGroup": current, "finished": True}
        sleep(settings["pollIntervalSec"])
    return {"taskGroup": current, "finished": False}


def poll_existing_task(config, task_group_id, on_log=print, client=None, sleep=time.sleep):
    settings = load_config({"config": config})
    client = client or CloudTestClient(settings)
    started_at = _now()
    stamp = started_at.astimezone().strftime("%Y%m%d%H%M%S")
    out_dir = Path(config["execution"]["outputRoot"]) / "cloudtest" / f"poll_{stamp}_{str(task_group_id)[-8:]}"
    out_dir.mkdir(parents=True, exist_ok=True)
    result_path = out_dir / "cloudtest-result.json"
    result = {"schemaVersion": "cloudtest-run-v1", "status": "running", "resumedPollOnly": True,
              "taskGroupId": str(task_group_id), "outputDir": str(out_dir), "startedAt": _iso(started_at), "error": ""}

    def persist():
        _atomic_json(result_path, result)

    persist()
    on_log(f"续查任务组 {task_group_id}（超时 {settings['taskTimeoutSec']} 秒，每 {settings['pollIntervalSec']} 秒查询一次）")
    try:
        def update(group, polls):
            result["polling"] = {"taskGroup": group, "polls": polls, "lastPolledAt": _iso()}
            persist()

        polling = poll_task_group(client, str(task_group_id), settings, on_log, update, sleep)
        if not polling["finished"]:
            result["status"] = "timed_out"
            result["error"] = f"等待云测试完成超时（{settings['taskTimeoutSec']} 秒），任务组 {task_group_id} 仍未结束"
        else:
            final = final_status(polling["taskGroup"])
            result["status"] = final["status"]
            result["error"] = final["error"]
            group = polling["taskGroup"]
            category = ((group.get("categoryList") or [24])[0])
            try:
                report = fetch_task_report(client, task_group_id, category)
                html_path = write_cloudtest_html_report(result, report, out_dir)
                result["report"] = {"htmlPath": html_path, "fetchedAt": _iso(),
                                    "summary": summarize_report(report)}
                if report["errors"]:
                    result["report"]["dataErrors"] = report["errors"]
            except Exception as error:
                result["report"] = {"htmlPath": "", "fetchedAt": _iso(), "error": str(error)}
                on_log(f"[warn] 云测试报告页生成失败: {error}")
            on_log("===== 云测试结果 =====")
            on_log(f"任务组: {task_group_id}（{group.get('taskGroupName') or ''}）")
            on_log(f"状态: {STATUS_LABELS.get(group.get('status'), group.get('status'))}"
                   f"（status={group.get('status')} resultStatus={group.get('resultStatus')}）")
            on_log(f"结果文件: {result_path}")
            if result["report"].get("htmlPath"):
                on_log(f"结果页面: {result['report']['htmlPath']}")
        persist()
        return result
    except KeyboardInterrupt as error:
        result["status"] = "interrupted"
        result["error"] = str(error) or "云测试轮询被中断"
        persist()
        raise
    except Exception as error:
        result["status"] = "failed"
        result["error"] = str(error)
        persist()
        raise
    finally:
        result["finishedAt"] = _iso()
        result["elapsedSec"] = round((_now() - started_at).total_seconds())
        persist()


def main(argv=None):
    parser = argparse.ArgumentParser(description="续查已有 AGC 云测试任务")
    parser.add_argument("task_group_id", help="纯数字任务组 ID")
    parser.add_argument("--config", "-c", default="./config/autorun.config.json")
    args = parser.parse_args(argv)
    if not args.task_group_id.isdigit():
        parser.error("任务组 ID 必须为纯数字")
    config = load_autorun_config(args.config)
    result = poll_existing_task(config, args.task_group_id)
    return 0 if result["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

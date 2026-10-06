"""Python batch execution and post-validation coordination."""

import asyncio
from copy import deepcopy
from datetime import datetime, timezone
import os
from pathlib import Path

from pyautorun.orchestration.artifacts import cleanup_case
from pyautorun.orchestration.batch_state import BatchStateStore
from pyautorun.orchestration.case_run import now, run_case, safe_name, write_json
from pyautorun.orchestration.cases import discover_cases
from pyautorun.cloud.cloudtest import load_config as load_cloud_config
from pyautorun.cloud.cloudtest_submit import submit_cloud_test_for_project, finish_cloud_test_polling
from pyautorun.reporting.failure_analysis import analyze_uitest_failures
from pyautorun.devices.ohostest import normalize_config as normalize_ohostest_config
from pyautorun.orchestration.preflight import validate_server_config
from pyautorun.reporting.reports import write_batch_report
from pyautorun.runtime.usage import add_compile_usage, add_token_usage
from pyautorun.whitebox_eval.runtime.adapter import prepare_whitebox_input


def _seconds(start, end):
    try:
        first = datetime.fromisoformat(str(start).replace("Z", "+00:00"))
        last = datetime.fromisoformat(str(end).replace("Z", "+00:00"))
        return max(0, round((last - first).total_seconds()))
    except (ValueError, TypeError):
        return 0


def _report(name, message):
    print(f"[{name}] {message}", flush=True)


async def _cloud_branch(config, settings, case_info, agent_result, cloud_submit_lock):
    out_dir = str(Path(agent_result["resultPath"]).parent / "cloudtest")
    log = lambda message: _report(case_info["name"], f"云测试：{message}")
    try:
        async with cloud_submit_lock:
            submission = await asyncio.to_thread(
                submit_cloud_test_for_project, config, agent_result.get("buildProjectDir") or
                agent_result.get("projectDir") or "", "", case_info["name"], "", case_info["name"],
                out_dir, log, None, settings)
        return await asyncio.to_thread(finish_cloud_test_polling, submission, log)
    except Exception as error:
        return {"status": "failed", "error": str(error), "outputDir": out_dir}


async def _whitebox_branch(evaluator, batch_id, case_info, agent_result, execution, config):
    if not evaluator or not agent_result.get("projectDir"):
        return None
    try:
        task = await asyncio.to_thread(prepare_whitebox_input, batch_id, case_info, agent_result,
                                       execution, config)
        return await evaluator.schedule(task)
    except Exception as error:
        return {"status": "failed", "error": str(error), "judge": evaluator.judge}


def _cloud_case_summary(result):
    task = result.get("task") or {}
    return {"status": result.get("status") or "failed", "taskGroupId": task.get("taskGroupId") or "",
            "taskName": task.get("taskName") or "", "error": result.get("error") or "",
            "outputDir": result.get("outputDir") or ""}


async def run_batch(config, server, skill_runtime, run_id, target_root, target_id,
                    whitebox_evaluator=None, retry_plan=None, ohostest_runner=None, progress=_report):
    source = config["server"]["opencodeSource"]
    execution = deepcopy(config["execution"])
    execution["agent"] = "build" if source["mode"] == "softwareEngineering" else str(execution.get("agent") or source["agent"])
    execution["concurrency"] = max(1, int(execution.get("concurrency") or 1))
    execution["idleTimeoutSec"] = max(1, int(execution.get("idleTimeoutSec") or 600))
    execution["maxRuntimeSec"] = max(1, int(execution.get("maxRuntimeSec") or 6000))
    if not execution["agent"]:
        raise ValueError("未配置 execution.agent")
    ohos = normalize_ohostest_config({"config": config})
    if ohos["enabled"] and ohostest_runner is None:
        raise RuntimeError("Python ohosTest Runner 尚未配置，不能执行启用设备测试的批次")
    cloud = {"enabled": False, "settings": None}
    try:
        settings = load_cloud_config({"config": config})
        cloud = {"enabled": settings["enabled"], "settings": settings}
    except Exception as error:
        if (config.get("cloudTest") or {}).get("enabled") is not False:
            progress("environment", f"云测试配置不完整，跳过：{error}")
    discovered = discover_cases(execution["casesRoot"], require_ohostest=ohos["enabled"])
    cases = discovered["runnable"]
    skipped = discovered["skipped"]
    if retry_plan:
        lookup = {item["name"]: item for item in cases}
        missing = [name for name in retry_plan["selectedCaseNames"] if name not in lookup]
        if missing:
            raise ValueError(f"重试用例在当前 casesRoot 中不可执行: {', '.join(missing)}")
        cases = [lookup[name] for name in retry_plan["selectedCaseNames"]]
        skipped = []
    model = await validate_server_config(server.client, execution, server.server_config, source["mode"])
    root = Path(target_root)
    root.mkdir(parents=True, exist_ok=True)
    state = {"batchId": run_id, "targetId": target_id, "status": "running", "createdAt": now(),
             "updatedAt": now(), "agent": execution["agent"], "opencodeSourceMode": source["mode"],
             "providerId": model["providerId"], "modelId": model["modelId"],
             "concurrency": execution["concurrency"],
             "ohosTest": {"enabled": ohos["enabled"], "concurrency": 1 if ohos["enabled"] else 0},
             "cloudTest": {"enabled": cloud["enabled"], "testCategories":
                           cloud["settings"]["testCategories"] if cloud["enabled"] else []},
             "whiteboxEvaluation": {"enabled": bool(whitebox_evaluator),
                                    "concurrency": whitebox_evaluator.config["concurrency"] if whitebox_evaluator else 0,
                                    "judge": whitebox_evaluator.judge if whitebox_evaluator else None},
             "cases": {item["name"]: {"status": "skipped" if item.get("skipReason") else "pending",
                                      "stage": "skipped" if item.get("skipReason") else "queued",
                                      "caseRoot": item["caseRoot"], "projectName": item["projectName"],
                                      "projectDir": item["projectDir"],
                                      **({"skipReason": item["skipReason"]} if item.get("skipReason") else {}),
                                      "updatedAt": now()} for item in [*cases, *skipped]}}
    if retry_plan:
        state["retry"] = {"sourceBatchId": retry_plan["sourceBatchId"],
                          "requestedCaseName": retry_plan["requestedCaseName"]}
    store = BatchStateStore(root / "batch.json", state)
    (root / "batch.pid").write_text(str(os.getpid()) + "\n", encoding="utf-8")
    queue = asyncio.Queue()
    for case in cases:
        queue.put_nowait(case)
    results = {}
    post_jobs = []
    cloud_submit_lock = asyncio.Lock()
    ohos_lock = asyncio.Lock()
    analysis_lock = asyncio.Lock()
    stop_queue = False

    async def post_validate(case_info, result, run_cloud=True, run_ohos=True, run_whitebox=True):
        name = case_info["name"]
        cloud_job = _cloud_branch(config, cloud["settings"], case_info, result, cloud_submit_lock) if cloud["enabled"] and run_cloud else None
        whitebox_job = _whitebox_branch(whitebox_evaluator, run_id, case_info, result, execution,
                                       config["whiteboxEvaluation"]) if whitebox_evaluator and run_whitebox else None
        async def ohos_job():
            async with ohos_lock:
                return await ohostest_runner(case_info, result, ohos, root)
        ohos_task = ohos_job() if ohos["enabled"] and run_ohos else None
        tasks = [asyncio.create_task(job) if job else None for job in (cloud_job, ohos_task, whitebox_job)]
        outcomes = await asyncio.gather(*(job for job in tasks if job), return_exceptions=True)
        iterator = iter(outcomes)
        cloud_result, ohos_result, whitebox_result = [next(iterator) if job else None for job in tasks]
        if isinstance(ohos_result, Exception):
            ohos_result = {"status": "failed", "error": str(ohos_result)}
        if isinstance(cloud_result, Exception):
            cloud_result = {"status": "failed", "error": str(cloud_result)}
        if isinstance(whitebox_result, Exception):
            whitebox_result = {"status": "failed", "error": str(whitebox_result)}
        if ohos_result and ohos_result.get("resultPath"):
            async with analysis_lock:
                analysis = await analyze_uitest_failures(server.client, model, case_info, result, ohos_result)
            if analysis:
                ohos_result = {**ohos_result, "failureAnalysis": analysis}
        merged = dict(result)
        if ohos_result:
            merged["ohosTest"] = ohos_result
            merged["status"] = ohos_result.get("status") or "failed"
            merged["error"] = "" if merged["status"] == "completed" else ohos_result.get("error") or "ohosTest failed"
        if cloud_result:
            cloud_summary = _cloud_case_summary(cloud_result)
            merged["cloudTest"] = cloud_summary
            if merged["status"] in ("completed", "running"):
                merged["status"] = cloud_summary["status"]
                merged["error"] = cloud_summary["error"] if merged["status"] != "completed" else ""
        if whitebox_result:
            merged["whitebox"] = whitebox_result
        if result.get("agentStatus") not in ("completed", "running"):
            merged["status"] = result.get("agentStatus") or "failed"
            merged["error"] = result.get("agentError") or result.get("error") or "Agent failed"
        if merged["status"] == "running":
            merged["status"] = "completed"
        merged["finishedAt"] = now()
        merged["elapsedSec"] = _seconds(merged.get("startedAt"), merged["finishedAt"])
        write_json(merged["resultPath"], merged)
        case_state_path = Path(merged["resultPath"]).parent / "state.json"
        write_json(case_state_path, {**(store.state["cases"].get(name) or {}), "case": name,
                                     "status": merged["status"], "stage": merged["status"],
                                     "error": merged.get("error") or "", "finishedAt": merged["finishedAt"],
                                     "updatedAt": now()})
        store.set_case(name, {"status": merged["status"], "stage": merged["status"],
                              "error": merged.get("error") or "", "finishedAt": merged["finishedAt"],
                              "ohosTest": merged.get("ohosTest"), "cloudTest": merged.get("cloudTest"),
                              "whitebox": merged.get("whitebox")})
        if whitebox_evaluator:
            case_dir = Path(merged["resultPath"]).parent
            await asyncio.to_thread(cleanup_case, name, case_dir / "original", merged["projectDir"],
                                    merged.get("patchPath") or "", case_dir / "generate", False, True, False)
        progress(name, f"完成：{merged['status']}")
        return merged

    def schedule_post(case_info, agent_result, **options):
        async def finish_post():
            nonlocal stop_queue
            try:
                finished = await post_validate(case_info, agent_result, **options)
            except Exception as error:
                finished = {**agent_result, "status": "failed",
                            "error": f"后置评价/测试编排异常: {error}", "finishedAt": now()}
                if finished.get("resultPath"):
                    write_json(finished["resultPath"], finished)
                store.set_case(case_info["name"], {"status": "failed", "stage": "failed",
                                                   "error": finished["error"], "finishedAt": finished["finishedAt"]})
            results[case_info["name"]] = finished
            if finished["status"] != "completed" and execution.get("continueOnError") is False:
                stop_queue = True
            return finished
        post_jobs.append(asyncio.create_task(finish_post()))

    async def worker(index):
        nonlocal stop_queue
        while not stop_queue and not queue.empty():
            try:
                item = queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            name = item["name"]
            progress(name, f"开始执行（worker {index}）")
            try:
                result = await run_case(item, root, server.client, model, execution, skill_runtime, store,
                                        ohos_enabled=ohos["enabled"], cloud_enabled=cloud["enabled"],
                                        whitebox_enabled=bool(whitebox_evaluator), progress=progress)
                if ohos["enabled"] or cloud["enabled"] or whitebox_evaluator:
                    schedule_post(item, result)
                else:
                    results[name] = result
                    if result["status"] != "completed" and execution.get("continueOnError") is False:
                        stop_queue = True
            except Exception as error:
                result = getattr(error, "case_result", {"case": name, "status": "failed", "error": str(error)})
                if result.get("agentStatus") == "timed_out" and (ohos["enabled"] or cloud["enabled"]):
                    schedule_post(item, result, run_whitebox=bool(whitebox_evaluator))
                elif whitebox_evaluator and result.get("projectDir"):
                    schedule_post(item, result, run_cloud=False, run_ohos=False)
                else:
                    results[name] = result
                progress(name, f"失败：{result.get('error') or error}")
                if execution.get("continueOnError") is False:
                    stop_queue = True
            finally:
                queue.task_done()

    try:
        await asyncio.gather(*(worker(index + 1) for index in range(min(execution["concurrency"], len(cases)))))
        if post_jobs:
            await asyncio.gather(*post_jobs)
        while not queue.empty():
            pending = queue.get_nowait()
            store.set_case(pending["name"], {"status": "cancelled", "stage": "cancelled",
                                               "error": "前序用例失败且 continueOnError=false", "finishedAt": now()})
            results[pending["name"]] = {"case": pending["name"], "status": "cancelled",
                                        "error": "前序用例失败且 continueOnError=false"}
            queue.task_done()
        ordered = [results[item["name"]] for item in cases if item["name"] in results]
        failed = sum(item.get("status") != "completed" for item in ordered)
        summary = {"batchId": run_id, "targetId": target_id,
                   "status": "completed_with_failures" if failed else "completed", "finishedAt": now(),
                   "agent": execution["agent"], "opencodeSourceMode": source["mode"],
                   "providerId": model["providerId"], "modelId": model["modelId"],
                   "total": len(cases), "completed": len(cases) - failed, "failed": failed,
                   "skipped": [{"case": item["name"], "reason": item["skipReason"]} for item in skipped],
                   "tokenUsage": add_token_usage(*(item.get("tokenUsage") for item in ordered)),
                   "agentCompile": add_compile_usage(*(item.get("agentCompile") for item in ordered)),
                   "cloudTest": {"enabled": cloud["enabled"]},
                   "whiteboxEvaluation": {"enabled": bool(whitebox_evaluator),
                                          "judge": whitebox_evaluator.judge if whitebox_evaluator else None,
                                          "completed": sum((item.get("whitebox") or {}).get("status") == "completed" for item in ordered),
                                          "failed": sum(bool(item.get("whitebox")) and
                                                        (item["whitebox"].get("status") != "completed") for item in ordered)},
                   "results": ordered}
        if retry_plan:
            summary["retry"] = state["retry"]
        try:
            summary["reports"] = write_batch_report(root, summary, config.get("upload"),
                                                    lambda message: progress("archive", message))
        except Exception as error:
            summary["reportError"] = str(error)
        write_json(root / "summary.json", summary)
        store.set_batch({"status": summary["status"], "finishedAt": summary["finishedAt"]})
        return summary
    finally:
        (root / "batch.pid").unlink(missing_ok=True)

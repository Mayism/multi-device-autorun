"""Python batch execution and post-validation coordination."""

import asyncio
from copy import deepcopy
from datetime import datetime, timezone
import os
from pathlib import Path

from pyautorun.orchestration.artifacts import cleanup_case
from pyautorun.orchestration.batch_state import BatchStateStore
from pyautorun.orchestration.case_run import now, run_case, write_json
from pyautorun.orchestration.console_reporter import ConsoleReporter
from pyautorun.orchestration.cases import discover_cases
from pyautorun.harmony_eval.verification import prepare_verifiers
from pyautorun.orchestration.preflight import validate_server_config
from pyautorun.reporting.reports import write_batch_report
from pyautorun.runtime.usage import add_compile_usage, add_token_usage
from pyautorun.harmony_eval.scoring import score_case, summarize_scores


def _seconds(start, end):
    try:
        first = datetime.fromisoformat(str(start).replace("Z", "+00:00"))
        last = datetime.fromisoformat(str(end).replace("Z", "+00:00"))
        return max(0, round((last - first).total_seconds()))
    except (ValueError, TypeError):
        return 0


def _report(name, message):
    print(f"[{name}] {message}", flush=True)


async def run_batch(config, server, skill_runtime, run_id, target_root, target_id,
                    whitebox_evaluator=None, retry_plan=None, ohostest_runner=None, progress=_report,
                    prepared_verifiers=None):
    source = config["server"]["opencodeSource"]
    execution = deepcopy(config["execution"])
    execution["agent"] = "build" if source["mode"] == "softwareEngineering" else str(execution.get("agent") or source["agent"])
    execution["concurrency"] = max(1, int(execution.get("concurrency") or 1))
    execution["idleTimeoutSec"] = max(1, int(execution.get("idleTimeoutSec") or 600))
    execution["maxRuntimeSec"] = max(1, int(execution.get("maxRuntimeSec") or 6000))
    if not execution["agent"]:
        raise ValueError("未配置 execution.agent")
    verifiers = prepared_verifiers if prepared_verifiers is not None else await prepare_verifiers(
        config, execution["casesRoot"], {"ohostest_runner": ohostest_runner,
                                        "whitebox_evaluator": whitebox_evaluator})
    ohos_enabled = any(plugin.requires_ohostest_case for plugin in verifiers)
    cloud_enabled = any(plugin.requires_cloud_stage for plugin in verifiers)
    whitebox_plugins = [plugin for plugin in verifiers if plugin.retain_original]
    evaluator = whitebox_plugins[0].evaluator if whitebox_plugins else None
    cloud_plugins = [plugin for plugin in verifiers if plugin.requires_cloud_stage]
    discovered = discover_cases(execution["casesRoot"], require_ohostest=ohos_enabled)
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
             "verifications": {plugin.spec.id: {"type": plugin.spec.type, "enabled": True}
                               for plugin in verifiers},
             "ohosTest": {"enabled": ohos_enabled, "concurrency": 1 if ohos_enabled else 0},
             "cloudTest": {"enabled": cloud_enabled, "testCategories":
                           cloud_plugins[0].settings["testCategories"] if cloud_plugins else []},
             "whiteboxEvaluation": {"enabled": bool(evaluator),
                                    "concurrency": evaluator.config["concurrency"] if evaluator else 0,
                                    "judge": evaluator.judge if evaluator else None},
             "cases": {item["name"]: {"status": "skipped" if item.get("skipReason") else "pending",
                                      "stage": "skipped" if item.get("skipReason") else "queued",
                                      "caseRoot": item["caseRoot"], "projectName": item["projectName"],
                                      "projectDir": item["projectDir"],
                                      **({"skipReason": item["skipReason"]} if item.get("skipReason") else {}),
                                      "updatedAt": now()} for item in [*cases, *skipped]}}
    if retry_plan:
        state["retry"] = {"sourceBatchId": retry_plan["sourceBatchId"],
                          "requestedCaseName": retry_plan["requestedCaseName"]}
    reporter = ConsoleReporter([*cases, *skipped])
    store = BatchStateStore(root / "batch.json", state, reporter.case_usage)
    (root / "batch.pid").write_text(str(os.getpid()) + "\n", encoding="utf-8")
    reporter.start()

    async def refresh_dashboard():
        while True:
            await asyncio.sleep(1)
            reporter.render()

    refresh_task = asyncio.create_task(refresh_dashboard()) if reporter.dynamic else None
    user_progress = progress

    def progress(name, message):
        reporter.case_progress(name, message)
        if user_progress is not _report:
            user_progress(name, message)
    queue = asyncio.Queue()
    for case in cases:
        queue.put_nowait(case)
    results = {}
    post_jobs = []
    stop_queue = False

    async def post_validate(case_info, result):
        name = case_info["name"]
        active = [plugin for plugin in verifiers if plugin.should_run(result)]
        context = {"case_info": case_info, "agent_result": result, "root": root,
                   "server": server, "model": model, "run_id": run_id,
                   "execution": execution, "progress": progress}
        for plugin in active:
            reporter.case_test_queued(name, plugin.legacy_result_key or plugin.spec.id)

        async def run_plugin(plugin):
            reporter.case_test_running(name, plugin.legacy_result_key or plugin.spec.id)
            try:
                outcome = await plugin.verify(context)
            except Exception as error:
                outcome = {"status": "failed", "error": str(error)}
            outcome = outcome or {"status": "unavailable", "error": "验证器未返回结果"}
            reporter.case_test_finished(name, plugin.legacy_result_key or plugin.spec.id, outcome)
            return outcome

        outcomes = await asyncio.gather(*(run_plugin(plugin) for plugin in active))
        merged = dict(result)
        merged["verifications"] = dict(result.get("verifications") or {})
        for plugin, outcome in zip(active, outcomes):
            merged["verifications"][plugin.spec.id] = plugin.result(outcome).to_dict()
            if plugin.legacy_result_key:
                merged[plugin.legacy_result_key] = plugin.legacy_result(outcome)
            if plugin.affects_case_status and merged["status"] in ("completed", "running"):
                merged["status"] = outcome.get("status") or "failed"
                merged["error"] = "" if merged["status"] == "completed" else outcome.get("error") or f"{plugin.spec.id} failed"
        if result.get("agentStatus") not in ("completed", "running"):
            merged["status"] = result.get("agentStatus") or "failed"
            merged["error"] = result.get("agentError") or result.get("error") or "Agent failed"
        if merged["status"] == "running":
            merged["status"] = "completed"
        scoring_rules = (config.get("harmonyEval") or {}).get("scoring") or []
        if scoring_rules:
            merged["scoring"] = score_case(scoring_rules, merged)
            unavailable = [name for name, score in merged["scoring"].items()
                           if score["status"] != "scored"]
            if unavailable and merged["status"] == "completed":
                merged["status"] = "failed"
                merged["error"] = f"评分报告不可用: {', '.join(unavailable)}"
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
                              "whitebox": merged.get("whitebox"), "verifications": merged["verifications"],
                              "scoring": merged.get("scoring")})
        if whitebox_plugins:
            case_dir = Path(merged["resultPath"]).parent
            await asyncio.to_thread(cleanup_case, name, case_dir / "original", merged["projectDir"],
                                    merged.get("patchPath") or "", case_dir / "generate", False, True, False)
        progress(name, f"完成：{merged['status']}")
        reporter.case_finished(merged)
        return merged

    def schedule_post(case_info, agent_result):
        async def finish_post():
            nonlocal stop_queue
            try:
                finished = await post_validate(case_info, agent_result)
            except Exception as error:
                finished = {**agent_result, "status": "failed",
                            "error": f"后置评价/测试编排异常: {error}", "finishedAt": now()}
                if finished.get("resultPath"):
                    write_json(finished["resultPath"], finished)
                store.set_case(case_info["name"], {"status": "failed", "stage": "failed",
                                                   "error": finished["error"], "finishedAt": finished["finishedAt"]})
                reporter.case_finished(finished)
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
            reporter.case_started(name)
            if user_progress is not _report:
                user_progress(name, f"开始执行（worker {index}）")
            try:
                result = await run_case(item, root, server.client, model, execution, skill_runtime, store,
                                        ohos_enabled=ohos_enabled, cloud_enabled=cloud_enabled,
                                        whitebox_enabled=bool(whitebox_plugins), progress=progress,
                                        verification_ids=[plugin.spec.id for plugin in verifiers])
                reporter.case_agent_finished(result)
                if any(plugin.should_run(result) for plugin in verifiers):
                    schedule_post(item, result)
                else:
                    results[name] = result
                    reporter.case_finished(result)
                    if result["status"] != "completed" and execution.get("continueOnError") is False:
                        stop_queue = True
            except Exception as error:
                result = getattr(error, "case_result", {"case": name, "status": "failed", "error": str(error)})
                reporter.case_agent_finished(result)
                if any(plugin.should_run(result) for plugin in verifiers):
                    schedule_post(item, result)
                else:
                    results[name] = result
                    reporter.case_finished(result)
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
            reporter.case_cancelled(pending["name"], "前序用例失败且 continueOnError=false")
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
                   "verifications": {plugin.spec.id: {"type": plugin.spec.type,
                                     "completed": sum((item.get("verifications") or {}).get(plugin.spec.id, {}).get("status") ==
                                                      "completed" for item in ordered),
                                     "failed": sum((item.get("verifications") or {}).get(plugin.spec.id, {}).get("status") ==
                                                   "failed" for item in ordered)} for plugin in verifiers},
                   "cloudTest": {"enabled": cloud_enabled},
                   "whiteboxEvaluation": {"enabled": bool(evaluator),
                                          "judge": evaluator.judge if evaluator else None,
                                          "completed": sum((item.get("whitebox") or {}).get("status") == "completed" for item in ordered),
                                          "failed": sum(bool(item.get("whitebox")) and
                                                        (item["whitebox"].get("status") != "completed") for item in ordered)},
                   "results": ordered}
        scoring_rules = (config.get("harmonyEval") or {}).get("scoring") or []
        if scoring_rules:
            summary["harmonyEval"] = {"taskId": config["harmonyEval"]["taskId"],
                                      "scores": summarize_scores(ordered, scoring_rules)}
        if retry_plan:
            summary["retry"] = state["retry"]
        try:
            summary["reports"] = write_batch_report(root, summary, config.get("upload"),
                                                    lambda message: progress("archive", message))
        except Exception as error:
            summary["reportError"] = str(error)
        write_json(root / "summary.json", summary)
        store.set_batch({"status": summary["status"], "finishedAt": summary["finishedAt"]})
        reporter.finish()
        return summary
    except BaseException as error:
        reporter.finish(error)
        raise
    finally:
        if refresh_task:
            refresh_task.cancel()
            await asyncio.gather(refresh_task, return_exceptions=True)
        (root / "batch.pid").unlink(missing_ok=True)

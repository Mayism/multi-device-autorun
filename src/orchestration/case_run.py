"""Run one Agent case and save the existing Autorun artifact contract."""

import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import re

from pyautorun.orchestration.agent_case_workspace import (agent_case_layout, materialize_agent_case_projects,
                                   prepare_agent_case_workspace)
from pyautorun.orchestration.artifacts import cleanup_case, generate_patch, initialize_git_baseline
from pyautorun.runtime.session_monitor import quota_exceeded_message, run_monitored_session
from pyautorun.runtime.skill_runtime import install_project_skill, inspect_skill_workflow
from pyautorun.runtime.usage import (aggregate_session_messages, collect_compile_attempts, empty_compile_usage,
                    empty_token_usage)
from pyautorun.reporting.agent_trace import write_agent_trace


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_name(path.name + ".tmp")
    pending.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    pending.replace(path)


def safe_name(value):
    return re.sub(r"[^0-9A-Za-z._-]", "_", str(value))[:120] or "unnamed"


def _transcript(sessions):
    lines = []
    for session in sessions:
        lines.append(f"===== SESSION {session['sessionId']} =====")
        if session.get("error"):
            lines.extend((f"[读取失败] {session['error']}", ""))
            continue
        for message in session["messages"]:
            info = message.get("info") or {}
            lines.append(f"--- {str(info.get('role') or message.get('role') or 'unknown').upper()} "
                         f"{info.get('id') or message.get('id') or ''} ---")
            for part in message.get("parts") or []:
                kind = str(part.get("type") or "unknown").lower()
                if kind in ("text", "reasoning") and isinstance(part.get("text"), str):
                    lines.extend((f"[{kind}]", part["text"]))
                elif kind == "tool":
                    state = part.get("state") or {}
                    lines.append(f"[tool:{part.get('tool') or 'unknown'}] status={state.get('status') or 'unknown'}")
                    for key in ("input", "output", "error"):
                        value = state.get(key)
                        if value is not None and value != "":
                            lines.append(f"[{key}] {value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)}")
                elif kind not in ("step-start", "step-finish"):
                    lines.append(f"[{kind}] {json.dumps(part, ensure_ascii=False, indent=2)}")
            lines.append("")
    return "\n".join(lines) + "\n"


async def save_agent_logs(client, session_ids, generate_dir):
    sessions = []
    for session_id in dict.fromkeys(item for item in session_ids if item):
        try:
            raw = await client.list_messages(session_id, 0, 30)
            sessions.append({"sessionId": session_id, "messages": raw if isinstance(raw, list) else []})
        except Exception as error:
            sessions.append({"sessionId": session_id, "messages": [], "error": str(error)})
    generate = Path(generate_dir)
    messages_path = generate / "all-messages.json"
    transcript_path = generate / "agent-output.log"
    attempts_path = generate / "compile-attempts.json"
    attempts = collect_compile_attempts(sessions)
    write_json(messages_path, sessions)
    transcript_path.write_text(_transcript(sessions), encoding="utf-8")
    write_json(attempts_path, attempts)
    return {"messagesPath": str(messages_path), "transcriptPath": str(transcript_path),
            "compileAttemptsPath": str(attempts_path), "tokenUsage": aggregate_session_messages(sessions),
            "agentCompile": {key: value for key, value in attempts.items() if key != "items"},
            "agentCompileAttempts": attempts["items"]}


async def run_case(case_info, batch_root, client, model, execution, skill_runtime, store,
                   ohos_enabled=False, cloud_enabled=False, whitebox_enabled=False, progress=None):
    name = case_info["name"]
    run_dir = Path(batch_root) / safe_name(name)
    layout = agent_case_layout(case_info, run_dir)
    project_dir = layout["projectDir"]
    generate_dir = run_dir / "generate"
    patch_path = run_dir / "diff" / "changes.patch"
    result_path = run_dir / "result.json"
    state_path = run_dir / "state.json"
    console_path = generate_dir / "agent-console.log"
    generate_dir.mkdir(parents=True, exist_ok=True)
    started = datetime.now(timezone.utc)
    session_id = baseline = ""
    latest_usage = empty_token_usage()

    def console(kind, message):
        with console_path.open("a", encoding="utf-8") as stream:
            stream.write(f"[{now()}] [{kind}] {str(message).strip()}\n")

    def update(values):
        store.set_case(name, values)
        write_json(state_path, {"case": name, **store.state["cases"][name]})

    def notify(message):
        if progress:
            progress(name, message)
        console("progress", message)

    store.set_case(name, {"status": "running", "stage": "preparing", "startedAt": now(),
                          "runDir": str(run_dir), "projectName": case_info["projectName"],
                          "platform": case_info["platform"], "projectDir": project_dir,
                          "buildProjectDir": layout["buildProjectDir"]})
    console("start", f"开始执行；project={project_dir}")
    try:
        prompt = Path(case_info["promptPath"]).read_text(encoding="utf-8")
        if not prompt.strip():
            raise ValueError(f"PROMPT.md 内容为空: {case_info['promptPath']}")
        await asyncio.to_thread(prepare_agent_case_workspace, case_info, layout)
        installed = await asyncio.to_thread(install_project_skill, skill_runtime, project_dir)
        if installed:
            console("skill_prepared", f"{installed.get('name') or 'Skill'} 已预装")
        baseline = await asyncio.to_thread(initialize_git_baseline, project_dir)
        update({"stage": "session_creating", "baseline": baseline})
        notify("工程沙箱已就绪，正在创建 Agent 会话")
        session = await client.create_session(project_dir, 30)
        session_id = str((session or {}).get("id") or "")
        if not session_id:
            raise RuntimeError("OpenCode 创建 session 后未返回 session id")
        write_json(run_dir / "session.json", {"sessionId": session_id, "projectName": case_info["projectName"],
                                               "platform": case_info["platform"], "projectDir": project_dir,
                                               "buildProjectDir": layout["buildProjectDir"],
                                               "agent": execution["agent"], "providerId": model["providerId"],
                                               "modelId": model["modelId"], "createdAt": now()})
        update({"stage": "agent_running", "sessionId": session_id})
        console("session", f"Agent 会话已创建；sessionId={session_id}")

        def on_progress(event, data):
            nonlocal latest_usage
            if data.get("tokenUsage"):
                latest_usage = data["tokenUsage"]
                store.set_case(name, {"tokenUsage": latest_usage})
            if event == "message" and data.get("changed"):
                tool = data.get("latestTool")
                preview = re.sub(r"\s+", " ", str(data.get("latestPreview") or "")).strip()[:180]
                notify(f"工具 {tool['name']} {tool['status']}" if tool else preview or "模型响应已更新")
            elif event in ("permission_replied", "question_replied", "text_replied"):
                console("interaction", json.dumps({"event": event, **data}, ensure_ascii=False))

        monitored = await run_monitored_session(
            client, session_id, project_dir,
            {"parts": [{"type": "text", "text": prompt}], "agent": execution["agent"],
             "model": {"providerID": model["providerId"], "modelID": model["modelId"]}},
            generate_dir / "opencode-sse.jsonl", generate_dir / "opencode-polling.jsonl",
            idle_timeout_sec=execution.get("idleTimeoutSec") or 600,
            max_runtime_sec=execution.get("maxRuntimeSec") or 6000,
            on_progress=on_progress,
            on_quota_exceeded=lambda message, hard: console("quota", message))
        logs = await save_agent_logs(client, [session_id, *monitored["childSessionIds"]], generate_dir)
        usage = logs["tokenUsage"] if logs["tokenUsage"]["total"] else monitored["tokenUsage"]
        update({"stage": "artifacting", "childSessionIds": monitored["childSessionIds"]})
        workflow = await asyncio.to_thread(inspect_skill_workflow, skill_runtime, project_dir)
        if workflow:
            write_json(generate_dir / "skill-workflow.json", workflow)
        await asyncio.to_thread(generate_patch, project_dir, baseline, patch_path)
        await asyncio.to_thread(cleanup_case, name, layout["originalDir"], project_dir, patch_path,
                                generate_dir, True, not ohos_enabled, whitebox_enabled)
        await asyncio.to_thread(materialize_agent_case_projects, case_info, layout, run_dir)
        finished = datetime.now(timezone.utc)
        elapsed = round((finished - started).total_seconds())
        pending = ohos_enabled or cloud_enabled or whitebox_enabled
        result = {"case": name, "status": "running" if pending else "completed", "agentStatus": "completed",
                  "quotaLimited": monitored.get("quotaLimited", False), "sessionId": session_id,
                  "childSessionIds": monitored["childSessionIds"], "agent": execution["agent"],
                  "providerId": model["providerId"], "modelId": model["modelId"],
                  "startedAt": started.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                  "agentFinishedAt": now(), "agentElapsedSec": elapsed,
                  "finishReason": monitored["finishReason"], "tokenUsage": usage,
                  "agentCompile": logs["agentCompile"], "agentCompileAttempts": logs["agentCompileAttempts"],
                  "projectName": case_info["projectName"], "platform": case_info["platform"],
                  "projectDir": project_dir, "buildProjectDir": layout["buildProjectDir"],
                  "patchPath": str(patch_path), "resultPath": str(result_path),
                  "output": monitored.get("output") or "",
                  "logs": {"transcriptPath": logs["transcriptPath"], "messagesPath": logs["messagesPath"],
                           "compileAttemptsPath": logs["compileAttemptsPath"],
                           "consolePath": str(console_path)}}
        if not pending:
            result.update({"finishedAt": now(), "elapsedSec": elapsed})
        if workflow:
            result["skillWorkflow"] = workflow
        try:
            result["logs"]["htmlPath"] = write_agent_trace(
                logs["messagesPath"], case_name=name, agent_status=result["agentStatus"],
                model=f"{model['providerId']}/{model['modelId']}",
                started_at=result["startedAt"], finished_at=result["agentFinishedAt"], token_usage=usage)
        except Exception as error:
            console("trace-error", f"Agent HTML 日志生成失败: {error}")
        for key, enabled in (("ohosTest", ohos_enabled), ("cloudTest", cloud_enabled),
                             ("whitebox", whitebox_enabled)):
            if enabled:
                result[key] = {"status": "queued"}
        write_json(result_path, result)
        update({"status": result["status"], "stage": "ohostest_queued" if ohos_enabled else
                "cloudtest_queued" if cloud_enabled else "whitebox_queued" if whitebox_enabled else "completed",
                "agentStatus": "completed", "agentFinishedAt": result["agentFinishedAt"],
                "finishedAt": result.get("finishedAt"), "resultPath": str(result_path),
                "patchPath": str(patch_path), "tokenUsage": usage, "agentCompile": logs["agentCompile"]})
        console("complete", f"执行完成；完整输出={logs['transcriptPath']}")
        return result
    except Exception as error:
        if baseline and Path(project_dir).exists():
            try:
                await asyncio.to_thread(generate_patch, project_dir, baseline, patch_path)
            except Exception:
                pass
        await asyncio.to_thread(cleanup_case, name, layout["originalDir"], project_dir, patch_path,
                                generate_dir, False, False, whitebox_enabled)
        try:
            await asyncio.to_thread(materialize_agent_case_projects, case_info, layout, run_dir)
        except Exception:
            pass
        failed_ids = [getattr(error, "session_id", session_id),
                      *getattr(error, "child_session_ids", [])]
        try:
            logs = await save_agent_logs(client, failed_ids, generate_dir)
        except Exception:
            logs = None
        usage = (logs["tokenUsage"] if logs and logs["tokenUsage"]["total"] else
                 getattr(error, "token_usage", latest_usage))
        sse_path = generate_dir / "opencode-sse.jsonl"
        sse_quota = sse_path.exists() and quota_exceeded_message(sse_path.read_text(encoding="utf-8"))
        rate_limited = bool(getattr(error, "quota_limited", False) or quota_exceeded_message(error) or sse_quota)
        timed_out = "无活动" in str(error) or "总运行时间超过" in str(error)
        status = "rate_limited" if rate_limited else "timed_out" if timed_out else "failed"
        finished = datetime.now(timezone.utc)
        result = {"case": name, "status": status, "agentStatus": status, "agentError": str(error),
                  "quotaLimited": rate_limited, "sessionId": session_id,
                  "childSessionIds": getattr(error, "child_session_ids", []), "error": str(error),
                  "startedAt": started.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                  "finishedAt": now(), "elapsedSec": round((finished - started).total_seconds()),
                  "tokenUsage": usage or empty_token_usage(),
                  "agentCompile": logs["agentCompile"] if logs else empty_compile_usage(),
                  "agentCompileAttempts": logs["agentCompileAttempts"] if logs else [],
                  "projectName": case_info["projectName"], "platform": case_info["platform"],
                  "projectDir": project_dir, "buildProjectDir": layout["buildProjectDir"],
                  "resultPath": str(result_path), "patchPath": str(patch_path) if patch_path.exists() else "",
                  "logs": {"transcriptPath": logs["transcriptPath"] if logs else "",
                           "messagesPath": logs["messagesPath"] if logs else "",
                           "compileAttemptsPath": logs["compileAttemptsPath"] if logs else "",
                           "ssePath": str(sse_path), "pollingPath": str(generate_dir / "opencode-polling.jsonl"),
                           "consolePath": str(console_path)}}
        if logs and logs.get("messagesPath"):
            try:
                result["logs"]["htmlPath"] = write_agent_trace(
                    logs["messagesPath"], case_name=name, agent_status=status,
                    agent_error=str(error), model=f"{model['providerId']}/{model['modelId']}",
                    started_at=result["startedAt"], finished_at=result["finishedAt"], token_usage=result["tokenUsage"])
            except Exception as trace_error:
                console("trace-error", f"Agent HTML 日志生成失败: {trace_error}")
        console(status, str(error))
        write_json(result_path, result)
        update({"status": status, "stage": status, "error": str(error), "finishedAt": result["finishedAt"],
                "resultPath": str(result_path), "tokenUsage": result["tokenUsage"],
                "agentCompile": result["agentCompile"]})
        error.case_result = result
        raise

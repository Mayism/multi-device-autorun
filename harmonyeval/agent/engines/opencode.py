"""Run OpenCode with an EvalScope model proxy and preserve failure traces."""

import asyncio
import json
import os
import time
from pathlib import Path
from datetime import datetime, timezone
from harmonyeval.api.registry import executors
from harmonyeval.api.contracts import ExecutionResult
from harmonyeval.utils.io import write_json
from harmonyeval.agent.targets.inspection import inspect_runtime
from harmonyeval.utils.processes import stop_process, watch_cancellation


@executors.register("opencode")
class OpenCodeExecutor:
    version = "1"

    async def execute(self, public_case, target, context):
        from evalscope.agent.external.bridge.server import ModelProxyServer
        execution = context["task"]["active"]["execution"]
        workspace = context["workspace"]
        out = Path(context["output"]) / "generate"
        out.mkdir(parents=True, exist_ok=True)
        manifest = await asyncio.to_thread(inspect_runtime, target, execution["agent_name"], workspace)
        proxy = await ModelProxyServer.get_or_start()
        started = time.monotonic()
        started_at = datetime.now(timezone.utc).isoformat()
        events, errors, answer, tools = [], [], [], []
        usage = {}
        result = None
        trace_data = {}
        route = None
        try:
            async with proxy.trial_session(context["model"], "opencode") as route:
                config = target["config"]
                model_id = "harmony_eval/" + execution["model"]["name"]
                config["provider"] = {"harmony_eval": {
                    "npm": "@ai-sdk/openai-compatible", "name": "EvalScope",
                    "options": {"baseURL": route.base_url + "/openai/v1", "apiKey": route.token},
                    "models": {execution["model"]["name"]: {"name": execution["model"]["name"]}}}}
                config.update({"model": model_id, "small_model": model_id, "enabled_providers": ["harmony_eval"]})
                for name in manifest.get("agents", []):
                    config.setdefault("agent", {}).setdefault(name, {})["model"] = model_id
                write_json(target["config_path"], config)
                Path(target["config_path"]).chmod(0o600)
                proc = await asyncio.create_subprocess_exec(
                    target["binary"], "run", "--format", "json", "--agent", execution["agent_name"],
                    "--dir", workspace, "--model", model_id, public_case["question"],
                    cwd=workspace, env={**target["env"], "PWD": workspace},
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    limit=8 * 1024 * 1024, start_new_session=os.name != "nt")
                async def stderr_reader():
                    with (out / "stderr.jsonl").open("w") as stream:
                        while line := await proc.stderr.readline():
                            stream.write(json.dumps({"text": line.decode(errors="replace").rstrip()}, ensure_ascii=False) + "\n")
                stderr_task = asyncio.create_task(stderr_reader())
                cancellation_task = asyncio.create_task(watch_cancellation(proc, context.get("cancel_event")))
                try:
                    with (out / "events.jsonl").open("w") as stream:
                        while True:
                            remaining = execution["timeout"] - (time.monotonic() - started)
                            if remaining <= 0:
                                raise TimeoutError("Agent 执行超过总时限")
                            try:
                                line = await asyncio.wait_for(proc.stdout.readline(), min(remaining, execution["idle_timeout"]))
                            except asyncio.TimeoutError as error:
                                if time.monotonic() - started >= execution["timeout"]:
                                    raise TimeoutError(f"Agent执行超过总时限 {execution['timeout']} 秒") from error
                                raise TimeoutError(f"主会话CLI连续 {execution['idle_timeout']} 秒无输出；子Agent可能仍在运行，请检查子会话日志") from error
                            if not line:
                                break
                            raw = line.decode(errors="replace").strip()
                            try:
                                event = json.loads(raw)
                            except json.JSONDecodeError:
                                event = {"type": "log", "text": raw}
                            events.append(event)
                            stream.write(json.dumps(event, ensure_ascii=False) + "\n")
                            stream.flush()
                            part = event.get("part", {})
                            if event.get("type") == "text" and part.get("text"):
                                answer.append(part["text"])
                            if event.get("type") == "error":
                                errors.append(event.get("error", event))
                            if part.get("type") == "tool" or event.get("type") == "tool_use":
                                tools.append({"id": part.get("id"), "session_id": event.get("sessionID"),
                                              "name": part.get("tool"), "input": part.get("state", {}).get("input", {}),
                                              "status": part.get("state", {}).get("status"),
                                              "output": part.get("state", {}).get("output"),
                                              "error": part.get("state", {}).get("error")})
                    code = await asyncio.wait_for(proc.wait(), max(1, execution["timeout"] - (time.monotonic() - started)))
                    await stderr_task
                finally:
                    await stop_process(proc)
                    cancellation_task.cancel()
                    await asyncio.gather(cancellation_task, return_exceptions=True)
                    if not stderr_task.done():
                        stderr_task.cancel()
                        await asyncio.gather(stderr_task, return_exceptions=True)
                trace = route.recorder.snapshot()
                trace_data = trace.model_dump(mode="json")
                # All model requests captured here passed through EvalScope ModelAPI.
                usage = {"source": "evalscope-model-proxy", "trace": str(out / "agent-output.json"),
                         **(trace_data.get("total_usage") or {})}
                result = ExecutionResult("completed" if code == 0 and not errors else "failed",
                                         answer="\n".join(answer), workspace=workspace,
                                         error=json.dumps(errors, ensure_ascii=False) if errors else "" if code == 0 else f"OpenCode exit {code}",
                                         failure_category="agent" if code or errors else "",
                                         elapsed_seconds=time.monotonic() - started, usage=usage,
                                         capabilities=manifest, tool_calls=tools)
                if context.get("cancel_event") is not None and context["cancel_event"].is_set():
                    result.status, result.failure_category, result.error = "interrupted", "user", "评测已中断"
        except Exception as error:
            result = ExecutionResult("timed_out" if isinstance(error, (TimeoutError, asyncio.TimeoutError)) else "error",
                                     answer="\n".join(answer), workspace=workspace, error=f"{type(error).__name__}: {error}",
                                     failure_category="infrastructure", elapsed_seconds=time.monotonic() - started,
                                     usage=usage, capabilities=manifest, tool_calls=tools)
        finally:
            if route is not None:
                trace_data = route.recorder.snapshot().model_dump(mode="json")
                usage = {"source": "evalscope-model-proxy", "trace": str(out / "agent-output.json"),
                         **(trace_data.get("total_usage") or {})}
                if result is not None:
                    result.usage = usage
            await proxy.shutdown()
        from harmonyeval.report.trace import render_agent_trace
        messages = [{"info": {"role": "user"}, "parts": [{"type": "text", "text": public_case["question"]}]}]
        for event in events:
            if isinstance(event.get("part"), dict):
                messages.append({"info": {"role": "assistant"}, "parts": [event["part"]]})
        root_id = next((e["sessionID"] for e in events if e.get("sessionID")), "")
        from harmonyeval.agent.traces.session_capture import capture_sessions, session_tool_calls
        sessions, capture = await asyncio.to_thread(capture_sessions, target, root_id)
        if not sessions:
            sessions = [{"sessionId": root_id, "messages": messages}]
        else:
            tools = session_tool_calls(sessions)
            result.tool_calls = tools
        required = manifest.get("required_skills", [])
        read_skills = {call["input"].get("name") for call in tools if call.get("name") == "skill" and call.get("status") == "completed"}
        missing = sorted(set(required) - read_skills)
        if missing and result.status == "completed":
            result.status, result.failure_category = "failed", "agent"
            result.error = "未读取 required Skill: " + ", ".join(missing)
        write_json(out / "agent-output.json", {"answer": result.answer, "status": result.status,
                                               "sessions": sessions, "session_capture": capture, "model_trace": trace_data,
                                               "elapsed_seconds": result.elapsed_seconds})
        (out / "agent-output.html").write_text(render_agent_trace(
            sessions, case_name=public_case["case_id"], agent_status=result.status, agent_error=result.error,
            model=execution["model"]["name"], started_at=started_at, finished_at=datetime.now(timezone.utc).isoformat(),
            token_usage={"total": usage.get("total_tokens", 0)}, back_href="../../../../../../index.html",
            raw_log="events.jsonl", raw_messages="agent-output.json"))
        return result

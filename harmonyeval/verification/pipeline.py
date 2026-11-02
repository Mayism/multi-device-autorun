"""Schedule verification dependencies and coordinate resource locks."""

import asyncio
import shutil
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from harmonyeval.api.registry import verifiers
from harmonyeval.utils.io import write_json
from harmonyeval.agent.environments.toolchain import tool_environment
from harmonyeval.verification.base import result


_resource_lock = threading.Lock()


_resources = {}


@asynccontextmanager
async def resources(names):
    held = []
    try:
        for name in sorted(set(names)):
            with _resource_lock:
                lock = _resources.setdefault(name, threading.Lock())
            # Polling avoids leaking a lock when cancellation interrupts acquire().
            while not lock.acquire(blocking=False):
                await asyncio.sleep(0.05)
            held.append(lock)
        yield
    finally:
        for lock in reversed(held):
            lock.release()


async def capture_verification_inputs(task, case, output):
    """Optional workflow hook: freeze input evidence before the agent can edit it."""
    async def capture(flows, parent):
        for config in flows:
            folder = Path(parent) / "verification" / config["id"]
            method = getattr(verifiers.get(config["type"])(), "capture_input", None)
            if method is not None:
                folder.mkdir(parents=True, exist_ok=True)
                try:
                    value = {"status": "completed", "data": await method(case, config)}
                except Exception as error:
                    value = {"status": "unavailable", "error": f"{type(error).__name__}: {error}"}
                write_json(folder / "input-evidence.json", value)
            if config.get("steps"):
                await capture(config["steps"], folder)
    await capture(task["active"]["verification"], output)


async def pipeline(task, case, execution, output, cancel_event=None):
    results = {}
    pending = list(task["active"]["verification"])
    async def run(config):
        if cancel_event is not None and cancel_event.is_set():
            return result(config, "skipped", error="评测已中断")
        cls = verifiers.get(config["type"])
        dependencies = config.get("depends_on", [])
        if any(results[d]["status"] != "completed" for d in dependencies):
            return result(config, "skipped", error="前置评估流程未完成")
        if execution.status != "completed" and config.get("requires_execution", True):
            return result(config, "unavailable", error=f"Agent执行未完成: {execution.error}")
        folder = Path(output) / "verification" / config["id"]
        folder.mkdir(parents=True, exist_ok=True)
        context = {"task": task, "output": str(folder),
                   "cancel_event": cancel_event,
                   "temporary_projects": [],
                   "env": tool_environment({**task["active"]["execution"].get("enviroment", {}),
                                             **{k: config[k] for k in ("deveco_home", "flutter_home") if config.get(k)}})}
        try:
            workflow = cls()
            async with resources(workflow.requirements(config)):
                return await workflow.verify(case, execution, {d: results[d] for d in dependencies}, context, config)
        except Exception as error:
            return result(config, "unavailable", error=f"{type(error).__name__}: {error}")
        finally:
            for path in context["temporary_projects"]:
                await asyncio.to_thread(shutil.rmtree, path, True)
    while pending:
        ready = [c for c in pending if all(d in results for d in c.get("depends_on", []))]
        if not ready:
            raise ValueError("评估流程存在无法解析的依赖")
        values = await asyncio.gather(*(run(c) for c in ready))
        for config, value in zip(ready, values):
            results[config["id"]] = value.to_dict()
            pending.remove(config)
    return results

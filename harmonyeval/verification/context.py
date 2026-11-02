"""Provide command execution, workflow settings and isolated grading projects."""

import asyncio
import shutil
import time
from pathlib import Path
from harmonyeval.config.loader import read_yaml
from harmonyeval.utils.paths import inside
from harmonyeval.utils.processes import stop_process, watch_cancellation


def workflow_settings(case, config):
    meta = case.metadata.get("verification", {})
    declared = meta.get(config["id"], meta.get(config["type"], {}))
    if not declared and case.expected.get("tests"):
        tests = inside(case.root, case.expected["tests"], exists=True)
        source = tests / "verification.yaml" if tests.is_dir() else tests
        if source.suffix in (".yaml", ".yml") and source.is_file():
            declared = read_yaml(source)
    return {**(declared or {}), **config}


def command_args(command, project, output):
    if not isinstance(command, list) or not command or not all(isinstance(x, str) for x in command):
        raise ValueError("command 必须是参数数组，不接受 shell 字符串")
    return [x.replace("${project}", str(project)).replace("${output}", str(output)) for x in command]


async def command_run(command, project, context, label, timeout=600):
    args = command_args(command, project, context["output"])
    start = time.monotonic()
    out = Path(context["output"])
    with (out / f"{label}.stdout.log").open("wb") as stdout, (out / f"{label}.stderr.log").open("wb") as stderr:
        proc = await asyncio.create_subprocess_exec(*args, cwd=project, env=context["env"], stdout=stdout,
                                                     stderr=stderr, start_new_session=__import__('os').name != "nt")
        watcher = asyncio.create_task(watch_cancellation(proc, context.get("cancel_event")))
        try:
            code = await asyncio.wait_for(proc.wait(), timeout)
        finally:
            await stop_process(proc)
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)
    if context.get("cancel_event") is not None and context["cancel_event"].is_set():
        raise InterruptedError("评测已中断")
    return {"exit_code": code, "seconds": time.monotonic() - start,
            "stdout": str(out / f"{label}.stdout.log"), "stderr": str(out / f"{label}.stderr.log")}


async def isolated_project(execution, context):
    import tempfile
    project = Path(tempfile.mkdtemp(prefix="harmony-eval-verify-"))
    context["temporary_projects"].append(str(project))
    await asyncio.to_thread(shutil.copytree, execution.project, project,
                            dirs_exist_ok=True,
                            ignore=shutil.ignore_patterns(".git", "node_modules", "oh_modules", ".hvigor", "build"))
    return project

"""Python hvigor build gate and upstream build-result summaries."""

from pathlib import Path
import re
import shutil
import subprocess
import time


def _cleanup_empty():
    return {"attempted": False, "removedPaths": [], "failedPaths": []}


def changed_modules(files):
    modules = set()
    for file in files:
        parts = [part for part in file.replace("\\", "/").split("/") if part]
        for index, part in enumerate(parts[:-1]):
            if part == "src" and parts[index + 1] == "main":
                modules.add("/".join(parts[:index]) or ".")
                break
    return sorted(modules)


def _summary(enabled, status, modules=None, results=None, diagnostics=None, run_dir=None,
             duration=0, gate=False):
    return {"enabled": enabled, "status": status,
            "checkedModules": modules or [], "moduleResults": results or [],
            "hardGateTriggered": gate, "durationMs": duration, "cleanup": _cleanup_empty(),
            **({"hvigorRunDir": run_dir} if run_dir is not None else {}),
            **({"scoreCap": 59} if gate else {}),
            **({"diagnostics": diagnostics} if diagnostics is not None else {})}


def agent_build_summary(agent):
    attempts = agent.get("attempts") or []
    if agent.get("status") == "not_run" or not attempts:
        return {**_summary(False, "not_enabled", diagnostics="生成 Agent 未输出编译结果。"),
                "buildCheckSource": "agent"}
    results = []
    for index, attempt in enumerate(attempts):
        command = next((match.group(1) for value in [*(attempt.get("tasks") or []),
                       attempt.get("command") or ""]
                       if (match := re.search(r"\b(assembleHar|assembleHap|assembleHsp|assembleApp)\b", value, re.I))), None)
        if not command:
            continue
        command = {name.lower(): name for name in ("assembleHar", "assembleHap", "assembleHsp", "assembleApp")}[command.lower()]
        item = {"modulePath": ".", "moduleName": attempt.get("description") or f"agent-attempt-{index + 1}",
                "command": command,
                "status": "success" if attempt["outcome"] == "succeeded" else
                          "failed" if attempt["outcome"] == "failed" else "skipped",
                "durationMs": attempt.get("durationMs") or 0,
                "diagnostics": f'生成 Agent 编译尝试 {index + 1}：{attempt["outcome"]}' +
                               (f'，退出码 {attempt["exitCode"]}' if attempt.get("exitCode") is not None else "") + "。"}
        if attempt.get("exitCode") is not None:
            item["exitCode"] = attempt["exitCode"]
        results.append(item)
    failed = agent["status"] == "failed"
    interrupted = agent["status"] in ("interrupted", "unknown")
    status = "failed" if failed else "skipped" if interrupted else "success"
    word = "失败" if failed else "未完成" if interrupted else "成功"
    counts = agent.get("summary") or {}
    diagnostics = (f'生成 Agent 最后一次有效编译{word}；共 {counts.get("attempts", 0)} 次尝试'
                   f'（成功 {counts.get("succeeded", 0)}，失败 {counts.get("failed", 0)}，'
                   f'中断 {counts.get("interrupted", 0)}）。')
    return {**_summary(True, status, ["agent"], results, diagnostics,
                       duration=sum(item.get("durationMs") or 0 for item in attempts), gate=failed),
            "buildCheckSource": "agent"}


def remote_build_summary(success):
    if success:
        return {**_summary(True, "success", diagnostics="上游提交的工程编译成功，已跳过本地 hvigor 编译复验。"),
                "buildCheckSource": "remote"}
    return {**_summary(True, "failed", ["remote"], [{"modulePath": ".", "moduleName": "remote",
            "command": "assembleApp", "status": "failed", "durationMs": 0,
            "diagnostics": "上游提交的工程编译失败。"}],
            "上游提交的工程编译失败，已跳过本地 hvigor 编译复验。", gate=True),
            "buildCheckSource": "remote"}


def _run(command, cwd, timeout):
    started = time.monotonic()
    try:
        result = subprocess.run(command, cwd=cwd, capture_output=True, timeout=timeout / 1000, check=False)
        status = "success" if result.returncode == 0 else "failed"
        return {"status": status, "exitCode": result.returncode,
                "stdout": result.stdout[-8192:].decode("utf-8", errors="replace"),
                "stderr": result.stderr[-8192:].decode("utf-8", errors="replace"),
                "durationMs": int((time.monotonic() - started) * 1000)}
    except subprocess.TimeoutExpired:
        return {"status": "timeout", "durationMs": int((time.monotonic() - started) * 1000),
                "stdout": "", "stderr": ""}


def _cleanup(workspace, modules):
    root = Path(workspace).resolve()
    targets = [root / name for name in (".hvigor", "build", "oh_modules")]
    for module in modules:
        parent = root if module == "." else root / module
        targets += [parent / name for name in ("build", "oh_modules", ".preview")]
    removed = []
    failed = []
    for target in dict.fromkeys(targets):
        relative = target.relative_to(root).as_posix()
        try:
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            else:
                target.unlink(missing_ok=True)
            removed.append(relative)
        except OSError as error:
            failed.append({"path": relative, "reason": str(error)})
    return {"attempted": True, "removedPaths": removed, "failedPaths": failed}


def run_hvigor_check(enabled, workspace=None, changed_files=(), run_dir=None, timeout_ms=300000):
    started = time.monotonic()
    def finish(summary, modules=()):
        summary["durationMs"] = int((time.monotonic() - started) * 1000)
        if summary["status"] not in ("failed", "timeout") and workspace:
            summary["cleanup"] = _cleanup(workspace, modules)
        return summary
    if not enabled:
        return finish(_summary(False, "not_enabled", diagnostics=
                               "hvigor build check is disabled by HMOS_HVIGOR_BUILD_CHECK_ENABLED"))
    if not workspace:
        return finish(_summary(True, "tool_unavailable", diagnostics="hvigor build check workspace is unavailable",
                               run_dir=run_dir, gate=True))
    modules = changed_modules(changed_files)
    if not modules:
        return finish(_summary(True, "skipped", diagnostics="no changed HarmonyOS module under src/main",
                               run_dir=run_dir), modules)
    if not run_dir:
        return finish(_summary(True, "tool_unavailable", modules, diagnostics="hvigor run directory is unavailable",
                               gate=True), modules)
    run_root = Path(run_dir)
    hvigor = next((path for path in (run_root / "hvigorw", run_root / "bin" / "hvigorw")
                   if path.is_file() and path.stat().st_mode & 0o111), None)
    if not hvigor:
        return finish(_summary(True, "tool_unavailable", modules, run_dir=run_dir,
                               diagnostics="hvigorw is unavailable", gate=True), modules)
    version = _run([str(hvigor), "--version"], workspace, timeout_ms)
    if version["status"] != "success":
        status = "timeout" if version["status"] == "timeout" else "tool_unavailable"
        return finish(_summary(True, status, modules, run_dir=run_dir,
                               diagnostics=f'hvigorw --version {version["status"]}', gate=True), modules)
    results = []
    compilable = []
    for module in modules:
        root = Path(workspace) if module == "." else Path(workspace) / module
        source = next((path.read_text(encoding="utf-8", errors="replace")
                       for path in (root / "hvigorfile.ts", root / "hvigorfile.js") if path.is_file()), "")
        command = next((task for token, task in (("hapTasks", "assembleHap"), ("harTasks", "assembleHar"),
                                                 ("hspTasks", "assembleHsp")) if token in source), None)
        name = "entry" if module == "." else module.split("/")[-1]
        if command:
            compilable.append((module, name, command))
        else:
            results.append({"modulePath": module, "moduleName": name, "command": "assembleHar",
                            "status": "skipped", "durationMs": 0,
                            "diagnostics": "module hvigorfile does not declare hapTasks, harTasks, or hspTasks"})
    if not compilable:
        return finish(_summary(True, "skipped", modules, results, run_dir=run_dir,
                               diagnostics="changed modules do not declare supported hvigor task types"), modules)
    ohpm = next((path for path in (run_root.parent / "ohpm" / "bin" / "ohpm",
                                  run_root.parent / "bin" / "ohpm", run_root.parent / "ohpm")
                 if path.is_file() and path.stat().st_mode & 0o111), None)
    if not ohpm:
        return finish(_summary(True, "tool_unavailable", modules, run_dir=run_dir,
                               diagnostics="ohpm is unavailable", gate=True), modules)
    installed = _run([str(ohpm), "install"], workspace, timeout_ms)
    if installed["status"] != "success":
        return finish(_summary(True, installed["status"], modules, run_dir=run_dir,
                               diagnostics=f'ohpm install {installed["status"]}', gate=True), modules)
    for module, name, command in compilable:
        run = _run([str(hvigor), command, "--mode", "module", "-p", f"module={name}@default",
                    "-p", "product=default", "--no-daemon"], workspace, timeout_ms)
        results.append({"modulePath": module, "moduleName": name, "command": command,
                        "status": run["status"], **({"exitCode": run["exitCode"]} if "exitCode" in run else {}),
                        "durationMs": run["durationMs"], "stdoutExcerpt": run["stdout"],
                        "stderrExcerpt": run["stderr"]})
    if all(item["status"] != "failed" and item["status"] != "timeout" for item in results):
        run = _run([str(hvigor), "assembleApp", "--no-daemon"], workspace, timeout_ms)
        diagnostics = (f'整包 assembleApp 编译{"超时" if run["status"] == "timeout" else "失败"}：'
                       "组件包可编译，但整包编译未通过，判断为原代码问题，非新增修改引入。"
                       if run["status"] in ("failed", "timeout") else None)
        results.append({"modulePath": ".", "moduleName": "app", "command": "assembleApp",
                        "status": run["status"], **({"exitCode": run["exitCode"]} if "exitCode" in run else {}),
                        "durationMs": run["durationMs"], "stdoutExcerpt": run["stdout"],
                        "stderrExcerpt": run["stderr"],
                        **({"diagnostics": diagnostics} if diagnostics is not None else {})})
    status = ("timeout" if any(item["status"] == "timeout" for item in results) else
              "failed" if any(item["status"] == "failed" for item in results) else "success")
    diagnostics = next((item.get("diagnostics") for item in results if item["command"] == "assembleApp" and
                        item["status"] in ("failed", "timeout")), None)
    return finish(_summary(True, status, modules, results, diagnostics, run_dir,
                           gate=status in ("failed", "timeout")), modules)

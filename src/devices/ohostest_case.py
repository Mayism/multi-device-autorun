"""Stage generated cases and run the Python ohosTest SWE phase."""

import asyncio
import argparse
from contextlib import nullcontext
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time

from pyautorun.orchestration.case_run import now, write_json
from pyautorun.devices.device_lease import device_lease
from pyautorun.devices.ohostest import classify_result
from pyautorun.devices.ohostest_execution import CommandLog, run_execution
from pyautorun.devices.ohostest_compat import (apply_answer_device_type_checks, isolated_bundle_name,
                              rewrite_bundle_name, temporary_device_types)
from pyautorun.devices.ohostest_project import (execution_groups, load_case_metadata, load_execution_config,
                               select_devices)
from pyautorun.devices.json5_lite import read_loose_json5
from pyautorun.orchestration.sandbox_copy import copy_project
from pyautorun.devices.ohostest_web import WEB_PORT, web_service


class _SkippedCase(Exception):
    pass


def _relative_or_absolute(path, root):
    try:
        return str(Path(path).relative_to(root))
    except ValueError:
        return str(path)


def _inside(root, candidate):
    root = Path(root).resolve()
    target = Path(candidate).resolve()
    return target == root or root in target.parents


def stage_generated_case(case_info, case_run_dir, patch_path):
    case_root = Path(case_info["caseRoot"])
    destination = Path(case_run_dir)
    metadata_path = case_root / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    for field in ("base_project", "test_patch", "golden_patch"):
        if not metadata.get(field):
            raise ValueError(f"用例未配置 metadata.{field}: {metadata_path}")
    if not Path(patch_path).is_file():
        raise ValueError(f"Agent 变更 patch 不存在: {patch_path}")
    project_name = case_info["projectName"]
    if project_name not in ("base", "task") or (destination / metadata["base_project"]).resolve() != (destination / project_name).resolve():
        raise ValueError(f"metadata.base_project 必须指向实际工程 {project_name}")
    if not (destination / project_name).is_dir():
        raise ValueError(f"Agent {project_name} 工程不存在: {destination / project_name}")
    staged = {}
    for field in ("test_patch", "golden_patch"):
        relative = Path(str(metadata[field]))
        source = (case_root / relative).resolve()
        target = (destination / relative).resolve()
        if relative.is_absolute() or not _inside(case_root, source) or not _inside(destination, target):
            raise ValueError(f"metadata.{field} 必须是用例目录内的相对路径: {relative}")
        if not source.is_file():
            raise ValueError(f"{field} 不存在: {source}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        staged[field] = str(target)
    # Hidden test assets are copied only after the Agent has finished.
    shutil.copy2(metadata_path, destination / "metadata.json")
    return {"inputDir": str(destination), "metadataPath": str(destination / "metadata.json"),
            "testPatchPath": staged["test_patch"], "goldenPatchPath": staged["golden_patch"]}


def _apply_patch(project, patch, label, log):
    project = Path(project)
    environment = dict(__import__("os").environ)
    environment["GIT_CEILING_DIRECTORIES"] = str(project.parent)
    for check in (True, False):
        command = ["git", "apply", "--ignore-whitespace", *(("--check",) if check else ()), str(patch)]
        completed = subprocess.run(command, cwd=project, env=environment, capture_output=True, text=True)
        log.record("command", command=" ".join(command), cwd=str(project),
                   result={"exitCode": completed.returncode, "stdout": completed.stdout,
                           "stderr": completed.stderr})
        if completed.returncode:
            raise RuntimeError(f"patch_apply_failed: {label}: {completed.stderr.strip()}")


def _copy_work(metadata, output_dir):
    patch_root = Path(output_dir) / "work" / "project"
    if patch_root.exists():
        shutil.rmtree(patch_root)
    if metadata["platform"] == "web":
        base = Path(metadata["baseProject"])
        relative = base.relative_to(metadata["caseDir"])
        copy_project(base, patch_root / relative)
        web = Path(metadata["caseDir"]) / "web"
        if not web.is_dir():
            raise ValueError("case_web_project_missing: web")
        copy_project(web, patch_root / "web")
        return {"patchRoot": str(patch_root), "workProject": str(patch_root / relative),
                "webProject": str(patch_root / "web")}
    copy_project(metadata["baseProject"], patch_root)
    return {"patchRoot": str(patch_root), "workProject": str(patch_root), "webProject": ""}


def _prepare_flutter_work(work, metadata, machine):
    root = Path(work["workProject"])
    host = root / "ohos"
    is_flutter = not (root / "hvigorfile.ts").exists() and (host / "hvigorfile.ts").is_file()
    if metadata["platform"] == "flutter" and not is_flutter:
        raise ValueError("case_flutter_project_invalid: Flutter root requires an ohos host")
    if not is_flutter:
        return
    if metadata["platform"] != "flutter":
        work["workProject"] = str(host)
    properties = host / "local.properties"
    existing = properties.read_text(encoding="utf-8") if properties.is_file() else ""
    configured = str((machine.get("paths") or {}).get("flutter") or "").strip()
    match = re.search(r"^flutter\.sdk=(.+)$", existing, re.M)
    sdk = configured or (match.group(1).strip() if match else "")
    if not sdk:
        return
    if not match:
        properties.write_text(existing + ("\n" if existing and not existing.endswith("\n") else "") +
                              "flutter.sdk=" + sdk.replace("\\", "/") + "\n", encoding="utf-8")
    plugin = host / "node_modules" / "flutter-hvigor-plugin"
    source = Path(sdk) / "packages" / "flutter_tools" / "hvigor"
    if not plugin.exists() and source.is_dir():
        plugin.parent.mkdir(parents=True, exist_ok=True)
        try:
            plugin.symlink_to(source, target_is_directory=True)
        except OSError:
            pass


def _metadata_result(metadata):
    skipped = [key for key in metadata.get("deviceTestSuites") or {}
               if key.strip().lower().replace("-", "").replace("_", "") in ("pc", "2in1")]
    result = {"platform": metadata["platform"], "testCaseTimeoutMs": metadata["testCaseTimeoutMs"],
              "failToPass": metadata["failToPass"], "passToPass": metadata["passToPass"],
              "deviceTestSuites": metadata.get("deviceTestSuites") or {}}
    if skipped:
        result["skippedDevices"] = skipped
    for key in ("enabledDevices", "deviceHapModules"):
        if metadata.get(key):
            result[key] = metadata[key]
    return result


def _summary(result):
    lines = ["# ohosTest Case Summary", "", f"Case: {result['caseId']}",
             f"Status: {result['status']}", f"Base Project: {result['baseProject']}",
             "", "## Runs", "", "| Run | Status | Devices | Tests | Failures | Errors | Passes | Ignored |",
             "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for phase in ("swe", "answer"):
        run = result["runs"].get(phase)
        devices = run.get("devices") or [] if run else []
        counts = [sum(item.get(key, 0) for item in devices) for key in
                  ("testsRun", "failures", "errors", "passes", "ignored")]
        lines.append(f"| {phase} | {run['status'] if run else 'not run'} | {len(devices)} | " +
                     " | ".join(map(str, counts)) + " |")
    if result["diagnostics"]:
        lines.extend(("", "## Diagnostics", "", *["- " + item for item in result["diagnostics"]]))
    return "\n".join(lines) + "\n"


def run_ohostest_case(case_dir, machine_config, out_dir, run_mode="answer", skip_build=False,
                      keep_emulators=False, keep_workdir=True, executor=None, devices=None):
    started = time.monotonic()
    started_at = now()
    case = Path(case_dir).resolve()
    output = Path(out_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    log = CommandLog(output / "commands.jsonl", executor)
    diagnostics = []
    runs = {}
    metadata = None
    work = None
    try:
        metadata = load_case_metadata(case)
        suites = metadata.get("deviceTestSuites") or {}
        if suites and all(key.strip().lower().replace("-", "").replace("_", "") in ("pc", "2in1")
                          for key in suites):
            phases = ("swe", "answer") if run_mode == "all" else (run_mode,)
            for phase in phases:
                phase_output = output / phase
                phase_output.mkdir(parents=True, exist_ok=True)
                runs[phase] = {"schemaVersion": "ohostest-matrix-v1", "project": metadata["baseProject"],
                               "status": "completed", "startedAt": started_at, "finishedAt": now(),
                               "durationMs": 0, "build": {"status": "passed", "appHap": "",
                               "testHap": "", "durationMs": 0}, "devices": [],
                               "diagnostics": ["unsupported_pc_device_skipped: " + ", ".join(suites)],
                               "artifacts": {"commandLog": "../commands.jsonl", "summary": "summary.md"}}
                write_json(phase_output / "result.json", runs[phase])
                (phase_output / "summary.md").write_text(f"# ohosTest {phase}\n\nStatus: completed\n", encoding="utf-8")
            raise _SkippedCase()
        work = _copy_work(metadata, output)
        _prepare_flutter_work(work, metadata, machine_config)
        _apply_patch(work["patchRoot"], metadata["testPatch"], "test_patch", log)
        phases = ("swe", "answer") if run_mode == "all" else (run_mode,)
        original_bundle = None
        if metadata.get("bundleNameIsolation"):
            harmony = Path(work["workProject"])
            if metadata["platform"] == "rn":
                harmony /= "harmony"
            elif metadata["platform"] == "flutter":
                harmony /= "ohos"
            original_bundle = (read_loose_json5(harmony / "AppScope" / "app.json5").get("app") or {}).get("bundleName")
            if not original_bundle:
                raise ValueError("bundle_name_missing")
        for phase in phases:
            if phase == "answer":
                _apply_patch(work["patchRoot"], metadata["goldenPatch"], "golden_patch", log)
            if original_bundle:
                rewrite_bundle_name(harmony, isolated_bundle_name(original_bundle, phase))
            machine = machine_config
            selection = select_devices(metadata, machine, devices)
            groups = execution_groups(metadata, selection)
            first_module = groups[0]["module"] if groups else None
            config = load_execution_config(work["workProject"], machine, metadata, first_module)
            phase_output = output / phase
            phase_output.mkdir(parents=True, exist_ok=True)
            group_results = []
            service = web_service(work["webProject"], output, phase, log) if work["webProject"] else nullcontext()
            with service:
                for group in groups:
                    group_config = config if not group["module"] or group["module"] == config["module"] else \
                        load_execution_config(work["workProject"], machine, metadata, group["module"])
                    if original_bundle:
                        group_config["bundleNameCleanup"] = {"prefixes": [original_bundle + "."],
                                                              "keep": [original_bundle, group_config["bundleName"]]}
                    group_output = phase_output if len(groups) == 1 else phase_output / "modules" / group["module"]
                    group_output.mkdir(parents=True, exist_ok=True)
                    with temporary_device_types(group_config, group["selection"]["devices"]) as assessment:
                        execution = run_execution(group_config, group["selection"], group_output, log,
                                                  skip_build=skip_build, keep_emulators=keep_emulators,
                                                  web_server_port=WEB_PORT if work["webProject"] else None)
                    if phase == "answer":
                        execution = apply_answer_device_type_checks(execution, assessment)
                    execution["schemaVersion"] = "ohostest-matrix-v1"
                    execution["artifacts"] = {"commandLog": "../commands.jsonl", "summary": "summary.md"}
                    write_json(group_output / "result.json", execution)
                    (group_output / "summary.md").write_text(
                        f"# ohosTest {phase}\n\nStatus: {execution['status']}\n", encoding="utf-8")
                    group_results.append(execution)
            if len(group_results) == 1:
                runs[phase] = group_results[0]
            else:
                devices = [device for group in group_results for device in group["devices"]]
                runs[phase] = {"schemaVersion": "ohostest-matrix-v1", "project": work["workProject"],
                               "status": "completed" if devices and all(item["status"] == "passed" for item in devices) else "failed",
                               "startedAt": started_at, "finishedAt": now(),
                               "durationMs": round((time.monotonic() - started) * 1000),
                               "build": group_results[0]["build"], "devices": devices,
                               "diagnostics": [item for group in group_results for item in group["diagnostics"]],
                               "module_runs": group_results,
                               "artifacts": {"commandLog": "../commands.jsonl", "summary": "summary.md"}}
                write_json(phase_output / "result.json", runs[phase])
                (phase_output / "summary.md").write_text(
                    f"# ohosTest {phase}\n\nStatus: {runs[phase]['status']}\n", encoding="utf-8")
    except _SkippedCase:
        pass
    except Exception as error:
        diagnostics.append(str(error))
        log.record("error", message=str(error))
    status = "completed" if runs and not diagnostics and all(item["status"] == "completed" for item in runs.values()) else "failed"
    result = {"schemaVersion": "ohostest-case-v1", "caseId": metadata["caseId"] if metadata else case.name,
              "caseDir": str(case), "baseProject": metadata["baseProject"] if metadata else "",
              "startedAt": started_at, "finishedAt": now(),
              "durationMs": round((time.monotonic() - started) * 1000), "status": status,
              "metadata": _metadata_result(metadata) if metadata else {"testCaseTimeoutMs": 0,
                "failToPass": [], "passToPass": [], "deviceTestSuites": {}},
              "runs": runs, "artifacts": {"result": _relative_or_absolute(output / "result.json", case),
                                            "summary": _relative_or_absolute(output / "summary.md", case),
                                            "commandLog": "commands.jsonl",
                                            **({"workdir": work["patchRoot"]} if work and keep_workdir else {})},
              "diagnostics": diagnostics}
    if "swe" in runs:
        result["artifacts"]["sweResult"] = _relative_or_absolute(output / "swe" / "result.json", case)
    if "answer" in runs:
        result["artifacts"]["answerResult"] = _relative_or_absolute(output / "answer" / "result.json", case)
    write_json(output / "result.json", result)
    (output / "summary.md").write_text(_summary(result), encoding="utf-8")
    if work and not keep_workdir:
        shutil.rmtree(output / "work", ignore_errors=True)
    return result


async def run_ohostest_for_batch(case_info, agent_result, settings, batch_root):
    started = datetime.now(timezone.utc)
    case_dir = Path(agent_result["resultPath"]).parent
    staged = await asyncio.to_thread(stage_generated_case, case_info, case_dir, agent_result["patchPath"])
    output = case_dir / ".ohostest-runs" / started.astimezone().strftime("%Y%m%d%H%M%S")
    output.mkdir(parents=True, exist_ok=True)
    machine_path = output / "machine.json"
    write_json(machine_path, settings["machineConfig"])
    work = output / "work"
    retained = case_dir / "ohostest-workdir"
    for path in (work, retained):
        if path.exists():
            shutil.rmtree(path)
    def execute_child():
        with device_lease(Path(batch_root) / ".device-validation.lock",
                          f"ohosTest:{case_info['name']}", settings["timeoutSec"]), \
             (output / "runner-process.log").open("wb") as stream:
            process = subprocess.Popen([sys.executable, "-m", "pyautorun.devices.ohostest_case", "--case", str(case_dir),
                                        "--out", str(output), "--machine-config", str(machine_path),
                                        "--run", "swe", "--keep-workdir"],
                                       cwd=Path(__file__).resolve().parents[2], stdin=subprocess.DEVNULL,
                                       stdout=stream, stderr=stream, start_new_session=(os.name != "nt"))
            try:
                process.wait(timeout=settings["timeoutSec"])
                return process.returncode, ""
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/pid", str(process.pid), "/t", "/f"], capture_output=True)
                else:
                    os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    if os.name == "nt":
                        process.kill()
                    else:
                        os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                return process.returncode, f"ohosTest 总运行时间超过 {settings['timeoutSec']} 秒"
    exit_code, stop_reason, runner = 1, "", None
    try:
        exit_code, stop_reason = await asyncio.to_thread(execute_child)
        if (output / "result.json").is_file():
            try:
                runner = json.loads((output / "result.json").read_text(encoding="utf-8"))
            except (OSError, ValueError) as error:
                stop_reason = f"ohosTest 结果文件损坏: {error}"
    except Exception as error:
        stop_reason = f"ohosTest 运行异常: {error}"
    finally:
        if work.exists():
            work.rename(retained)
        Path(staged["goldenPatchPath"]).unlink(missing_ok=True)
    finished = datetime.now(timezone.utc)
    outcome = classify_result({"runnerStatus": runner.get("status") if runner else "",
                               "firstDiagnostic": (runner.get("diagnostics") or [""])[0] if runner else "",
                               "stopReason": stop_reason, "exitCode": exit_code,
                               "inputDir": str(case_dir)})
    return {"status": outcome["status"], "runnerStatus": runner.get("status") if runner else "",
            "runnerVersion": "python", "runMode": "swe",
            "startedAt": started.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "finishedAt": finished.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "elapsedSec": round((finished - started).total_seconds()), "exitCode": exit_code,
            "signal": "", "error": outcome["error"], "inputCaseDir": str(case_dir),
            "metadataPath": staged["metadataPath"], "machineConfigPath": str(machine_path),
            "testPatchPath": staged["testPatchPath"], "outputDir": str(output),
            "resultPath": str(output / "result.json") if (output / "result.json").is_file() else "",
            "summaryPath": str(output / "summary.md") if (output / "summary.md").is_file() else "",
            "workDir": str(retained) if retained.exists() else ""}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Python ohosTest case runner")
    parser.add_argument("--case", required=True)
    parser.add_argument("--out")
    parser.add_argument("--machine-config", default="config/machine.json")
    parser.add_argument("--run", choices=("swe", "answer", "all"), default="answer")
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--keep-emulators", action="store_true")
    parser.add_argument("--keep-workdir", action="store_true")
    parser.add_argument("--device", action="append")
    args = parser.parse_args(argv)
    machine = json.loads(Path(args.machine_config).read_text(encoding="utf-8"))
    output = Path(args.out) if args.out else Path(args.case) / ".ohostest-runs" / datetime.now().strftime("%Y%m%d%H%M%S")
    result = run_ohostest_case(args.case, machine, output, args.run,
                               args.skip_build, args.keep_emulators, args.keep_workdir, devices=args.device)
    print(json.dumps({"status": result["status"], "out": str(output / "result.json"),
                      "summary": str(output / "summary.md")}, ensure_ascii=False))
    return 0 if result["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

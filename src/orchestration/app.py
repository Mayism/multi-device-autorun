"""Top-level Python Autorun orchestration."""

import asyncio
from datetime import datetime

from pyautorun.orchestration.batch import run_batch
from pyautorun.orchestration.batch_state import load_retry_plan, recover_interrupted_runs
from pyautorun.orchestration.case_run import safe_name, write_json
from pyautorun.orchestration.config import load_autorun_config
from pyautorun.devices.ohostest import normalize_config as normalize_ohostest_config
from pyautorun.devices.ohostest_case import run_ohostest_for_batch
from pyautorun.harmony_eval.verification import prepare_verifiers
from pyautorun.runtime.opencode_server import start_server
from pyautorun.runtime.platform import check_configured_emulator_ports, format_emulator_port_conflict
from pyautorun.orchestration.preflight import check_environment, validate_server_config
from pyautorun.reporting.reports import write_comparison_report
from pyautorun.orchestration.target_runtime import (allocate_run_directory, config_for_target,
                             create_shared_cases_snapshot, prepare_shared_generation_provider,
                             write_target_environment)


async def run_autorun(config_path, retry_batch_id="", retry_case="", check=False, on_log=print):
    config = config_path if isinstance(config_path, dict) else load_autorun_config(config_path)
    if check:
        result = await check_environment(config, on_log)
        return {"exitCode": 0 if result["checked"] else 1, "check": result}
    recover_interrupted_runs(config["execution"]["outputRoot"])
    targets = config["server"]["opencodeTargets"]["targets"]
    multiple = config["server"]["opencodeTargets"]["multiple"]
    if retry_batch_id and multiple:
        raise ValueError("多 Agent 对比暂不支持 --retry；请使用单 Agent 配置重试指定目标")
    retry = load_retry_plan(config["execution"]["outputRoot"], retry_batch_id, retry_case) if retry_batch_id else None
    ohos = normalize_ohostest_config({"config": config})
    if ohos["enabled"]:
        machine = ohos["machineConfig"]
        if not isinstance(machine.get("paths"), dict) or not isinstance(machine.get("devices"), list) or not machine["devices"]:
            raise ValueError("ohosTest.enabled=true 时必须配置 ohosTest.paths 和至少一个设备")
        conflicts = check_configured_emulator_ports(machine)
        if conflicts:
            raise ValueError("模拟器 HDC 端口检查失败；" + "；".join(map(format_emulator_port_conflict, conflicts)))
    run_id, run_root = allocate_run_directory(config["execution"]["outputRoot"])
    overlay = prepare_shared_generation_provider(config, run_id) if multiple else ""
    cases_root = create_shared_cases_snapshot(config, run_id, run_root) if multiple else config["execution"]["casesRoot"]
    verifiers = await prepare_verifiers(config, cases_root, {"ohostest_runner": run_ohostest_for_batch})
    target_results = []
    if multiple:
        fingerprints = []
        for target in targets:
            target_root = run_root / safe_name(target["id"])
            target_root.mkdir(parents=True, exist_ok=True)
            prepared, runtime = config_for_target(config, target, run_id, cases_root, "preflight")
            workspace = runtime / "workspace"
            workspace.mkdir(parents=True, exist_ok=True)
            server = None
            try:
                server = await start_server(prepared, workspace, reuse_existing=False,
                                            provider_overlay=overlay, log=on_log)
                model = await validate_server_config(server.client, prepared["execution"],
                                                     server.server_config, target["mode"])
                environment, _ = await write_target_environment(target_root, target, prepared, server, model)
                fingerprints.append(environment["generationModel"]["configFingerprint"])
            finally:
                if server:
                    await server.stop()
        if len(set(fingerprints)) != 1:
            raise ValueError("多 Agent 的 Provider/模型配置指纹不一致，禁止开始对比执行")
    exit_code = 0
    for target in targets:
        target_root = run_root / safe_name(target["id"])
        target_root.mkdir(parents=True, exist_ok=True)
        prepared, runtime = config_for_target(config, target, run_id, cases_root)
        workspace = runtime / "workspace"
        workspace.mkdir(parents=True, exist_ok=True)
        server = None
        try:
            server = await start_server(prepared, workspace, reuse_existing=False,
                                        provider_overlay=overlay, log=on_log)
            model = await validate_server_config(server.client, prepared["execution"],
                                                 server.server_config, target["mode"])
            _, skill_runtime = await write_target_environment(target_root, target, prepared, server, model)
            summary = await run_batch(prepared, server, skill_runtime, run_id, target_root, target["id"],
                                      retry_plan=retry, prepared_verifiers=verifiers)
            target_results.append({**target, "targetRoot": str(target_root), "summary": summary})
            if summary["failed"]:
                exit_code = 1
        except Exception as error:
            exit_code = 1
            on_log(f"[{target['label']}] 运行失败：{error}")
            write_json(target_root / "target-error.json", {"targetId": target["id"],
                       "status": "failed", "error": str(error),
                       "finishedAt": datetime.now().astimezone().isoformat()})
            target_results.append({**target, "targetRoot": str(target_root), "error": str(error)})
        finally:
            if server and config["server"].get("stopWhenFinished") is not False:
                await server.stop()
    comparison = write_comparison_report(run_root, run_id, config["execution"]["generationModel"], target_results)
    if multiple and not comparison["comparison"]["sameModelValidated"]:
        exit_code = 1
    return {"exitCode": exit_code, "runId": run_id, "runRoot": str(run_root),
            "overviewPath": comparison["overviewPath"], "targets": target_results}

"""Build, upload and submit AGC cloud-test jobs directly from Python."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
from uuid import uuid4

from pyautorun.cloud.cloudtest import load_config, rank_devices
from pyautorun.cloud.cloudtest_client import CloudTestClient, digest
from pyautorun.cloud.cloudtest_poll import _atomic_json, _iso, poll_task_group, STATUS_LABELS
from pyautorun.cloud.cloudtest import final_status, summarize_report
from pyautorun.cloud.cloudtest_report import fetch_task_report, write_cloudtest_html_report
from pyautorun.devices.json5_lite import read_loose_json5
from pyautorun.orchestration.sandbox_copy import copy_project


def read_app_profile(project_dir):
    project = Path(project_dir)
    app_json = project / "AppScope" / "app.json5"
    if not app_json.is_file():
        raise ValueError(f"未找到 AppScope/app.json5，不是 HarmonyOS 工程根目录: {project}")
    app = (read_loose_json5(app_json).get("app") or {})
    bundle_name = str(app.get("bundleName") or "").strip()
    version_name = str(app.get("versionName") or "").strip()
    if not bundle_name or not version_name:
        raise ValueError(f"AppScope/app.json5 缺少 bundleName 或 versionName: {app_json}")
    build_profile = project / "build-profile.json5"
    signing = []
    if build_profile.is_file():
        try:
            signing = (read_loose_json5(build_profile).get("app") or {}).get("signingConfigs") or []
        except (ValueError, OSError):
            pass
    count = sum(bool(item.get("name")) for item in signing if isinstance(item, dict))
    return {"bundleName": bundle_name, "versionName": version_name, "versionCode": app.get("versionCode"),
            "bundleType": str(app.get("bundleType") or ""), "hasSigningConfig": count > 0,
            "signingConfigCount": count, "buildProfilePath": str(build_profile)}


def apply_signing_overrides(build_project_dir, settings, on_log=print):
    project = Path(build_project_dir)
    if settings["bundleName"]:
        app_json = project / "AppScope" / "app.json5"
        parsed = read_loose_json5(app_json)
        app = parsed.get("app")
        if not isinstance(app, dict):
            raise ValueError(f"沙箱 AppScope/app.json5 缺少 app 节点: {app_json}")
        previous = app.get("bundleName") or "<空>"
        app["bundleName"] = settings["bundleName"]
        app_json.write_text(json.dumps(parsed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        on_log(f"bundleName 已替换: {previous} → {settings['bundleName']}")
    if settings["signingConfigs"]:
        build_profile = project / "build-profile.json5"
        parsed = read_loose_json5(build_profile)
        app = parsed.get("app")
        if not isinstance(app, dict):
            raise ValueError(f"沙箱 build-profile.json5 缺少 app 节点: {build_profile}")
        app["signingConfigs"] = settings["signingConfigs"]
        names = [str(item.get("name")) for item in settings["signingConfigs"] if item.get("name")]
        for product in app.get("products") or []:
            if not product.get("signingConfig") and names:
                product["signingConfig"] = names[0]
            elif product.get("signingConfig") and names and product["signingConfig"] not in names:
                on_log(f'[warn] product "{product.get("name")}" 引用的 signingConfig "{product["signingConfig"]}" 不在注入配置（{",".join(names)}）中')
        build_profile.write_text(json.dumps(parsed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        on_log(f"signingConfigs 已注入 {len(names)} 项（{','.join(names)}），将使用 release 签名打包")


def _run_logged(args, cwd, env, console_path, timeout_sec, on_log):
    started = datetime.now(timezone.utc)
    console = Path(console_path)
    console.parent.mkdir(parents=True, exist_ok=True)
    with console.open("a", encoding="utf-8") as stream:
        stream.write(f"\n[{_iso(started)}] {' '.join(map(str, args))}\n")
        stream.flush()
        process = subprocess.Popen(args, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   text=True, errors="replace", start_new_session=(os.name != "nt"))
        try:
            # communicate enforces a timeout and avoids blocking indefinitely on a partial line.
            output, _ = process.communicate(timeout=timeout_sec)
        except subprocess.TimeoutExpired as error:
            if os.name == "nt":
                process.kill()
            else:
                os.killpg(process.pid, signal.SIGKILL)
            output, _ = process.communicate()
            stream.write(output or "")
            raise TimeoutError(f"构建超时（{timeout_sec} 秒）") from error
        stream.write(output or "")
    for line in (output or "").splitlines():
        if re.search(r"\bERROR\b|Failed|fail", line, re.I):
            on_log(f"[build] {line}")
    return {"command": " ".join(map(str, args)), "startedAt": _iso(started), "finishedAt": _iso(),
            "exitCode": process.returncode}


def build_signed_app(project_dir, settings, console_path, on_log=print):
    paths = settings["paths"]
    hvigorw = paths["hvigorw"]
    ohpm = paths["ohpm"]
    for label, command in (("hvigorw", hvigorw), ("ohpm", ohpm)):
        if os.path.isabs(command) and not Path(command).exists():
            raise ValueError(f"{label} 配置的路径不存在: {command}（检查 server.hvigorw / server.ohpm / ohosTest.paths）")
    env = os.environ.copy()
    if paths["sdkHome"]:
        env["DEVECO_SDK_HOME"] = paths["sdkHome"]
    if paths["javaHome"]:
        env["JAVA_HOME"] = paths["javaHome"]
    steps = []
    if not (Path(project_dir) / "oh_modules").exists():
        on_log("工程缺少 oh_modules，先执行 ohpm install --all ...")
        steps.append(_run_logged([ohpm, "install", "--all"], project_dir, env, console_path,
                                 settings["buildTimeoutSec"], on_log))
        if steps[-1]["exitCode"]:
            raise RuntimeError(f"ohpm install 退出码 {steps[-1]['exitCode']}，日志: {console_path}")
    command = ([sys.executable, hvigorw] if hvigorw.endswith(".py") else
               ["node", hvigorw] if hvigorw.endswith(".js") else [hvigorw])
    command.extend(["--mode", "project", "-p", f"product={settings['product']}", "-p",
                    f"buildMode={settings['buildMode']}", "assembleApp", "--analyze=normal",
                    "--parallel", "--incremental", "--no-daemon"])
    steps.append(_run_logged(command, project_dir, env, console_path, settings["buildTimeoutSec"], on_log))
    return {"steps": steps, "consolePath": str(console_path), "exitCode": steps[-1]["exitCode"]}


def find_signed_app(project_dir):
    outputs = Path(project_dir) / "build"
    apps = sorted((path for path in outputs.rglob("*.app") if path.is_file()),
                  key=lambda path: path.stat().st_mtime, reverse=True) if outputs.exists() else []
    if not apps:
        raise ValueError(f"构建成功但未在 {outputs} 下找到 .app 产物")
    signed = next((path for path in apps if re.search("signed", path.name, re.I)), None)
    if not signed:
        names = ", ".join(path.name for path in apps)
        raise ValueError(f"只找到未签名 .app（{names}）。请先在工程 build-profile.json5 中配置 release 签名后重试")
    return {"path": str(signed), "size": signed.stat().st_size}


def prepare_app_artifact(project_dir, app_path, settings, out_dir, console_path, on_log=print):
    if app_path:
        app = Path(app_path).absolute()
        if not app.is_file():
            raise ValueError(f"--app 文件不存在: {app_path}")
        profile = None
        if project_dir:
            try:
                profile = read_app_profile(project_dir)
            except (ValueError, OSError):
                pass
        on_log(f"跳过构建，使用指定包: {app}")
        return {"appPath": str(app), "appProfile": profile, "build": None,
                "app": _app_info(profile, settings["bundleName"])}
    if not project_dir:
        raise ValueError("未指定工程目录（--case/--project-dir）或 .app 文件（--app）")
    profile = read_app_profile(project_dir)
    if not profile["hasSigningConfig"] and not settings["signingConfigs"]:
        raise ValueError("工程未配置签名且未提供补充签名：请在工程 build-profile.json5 配置 signingConfigs，"
                         "或在 config 的 cloudTest.signingConfigs 注入")
    build_dir = Path(out_dir) / "project"
    started = _iso()
    on_log(f"复制工程到构建沙箱: {build_dir}")
    copy_project(project_dir, build_dir)
    apply_signing_overrides(build_dir, settings, on_log)
    on_log(f"开始构建签名包（{settings['buildMode']}/{settings['product']}，最长 {settings['buildTimeoutSec']} 秒）...")
    build = build_signed_app(build_dir, settings, console_path, on_log)
    build = {"projectDir": str(build_dir), "sourceProjectDir": str(project_dir),
             "startedAt": started, "finishedAt": _iso(), **build}
    if build["exitCode"]:
        raise RuntimeError(f"hvigor assembleApp 退出码 {build['exitCode']}，日志: {console_path}")
    artifact = find_signed_app(build_dir)
    build["artifactPath"] = artifact["path"]
    build["artifactSize"] = artifact["size"]
    return {"appPath": artifact["path"], "appProfile": profile, "build": build,
            "app": _app_info(profile, settings["bundleName"])}


def _app_info(profile, bundle_name):
    if not profile:
        return {}
    return {"bundleName": bundle_name or profile["bundleName"],
            **{key: profile.get(key) for key in ("versionName", "versionCode", "bundleType")}}


def query_existing_packages(client, bundle_name, on_log=print):
    try:
        apps = client.list_apps()
        entries = [item for item in apps if item.get("packageName") == bundle_name] if bundle_name else []
        if entries:
            names = "；".join(f"{item.get('appName') or '?'}/{item.get('appVersion') or '?'}(id={item.get('id')})"
                             for item in entries)
            on_log(f"云端已有同包名上传记录 {len(entries)} 条: {names}（暂不删除旧包，将直接重新上传）")
        elif bundle_name:
            on_log("云端未发现同包名历史上传记录，直接上传新包")
        return entries
    except Exception as error:
        on_log(f"[warn] 查询历史包列表失败（继续上传）: {error}")
        return []


def upload_and_analyze_app(client, package, existing_count, settings, on_log=print):
    on_log(f"申请上传凭证并直传 OBS: {package['fileName']}（{package['fileSize'] / 1024 / 1024:.2f} MB）...")
    obs = client.request_upload_url(package["fileName"], package["fileSize"], package["sha256"])
    client.put_object(obs, package["appPath"], package)
    client.trigger_analyze(obs["objectId"])
    app_info = client.poll_analyze(obs["objectId"], timeout_ms=settings["analyzeTimeoutSec"] * 1000,
                                   on_progress=on_log)
    on_log(f"云端解析完成: appName={app_info.get('appName')} version={app_info.get('appVersion')} "
           f"appType={app_info.get('appType')} apiLevel={app_info.get('geApiLevel')} appInfoId={app_info.get('id')}")
    upload = {"objectId": obs["objectId"], "fileName": package["fileName"], "uploadedAt": _iso(),
              "existingSamePackageCount": existing_count,
              **{key: app_info.get(key) for key in ("appInfoId", "appName", "appVersion", "packageName",
                                                   "appType", "geApiLevel", "deviceKinds")}}
    upload["appInfoId"] = app_info.get("id")
    return upload, app_info


def select_cloud_devices(client, app_info, settings, on_log=print):
    devices = client.list_business_devices(app_info["appType"],
                                           ",".join(str(item["category"]) for item in settings["testCategories"]),
                                           [app_info["geApiLevel"]])
    if not devices:
        raise ValueError(f"可用真机列表为空（appType={app_info['appType']} "
                         f"testCategories={settings['testCategories']} apiLevels={app_info['geApiLevel']}）")
    try:
        api_level = int(app_info["geApiLevel"])
    except (TypeError, ValueError):
        api_level = 0
    exact = [device for device in devices if str(device.get("openharmonySdk")) == str(api_level)] if api_level else []
    if exact:
        on_log(f"包 API{api_level}：优先选择同 API 版本真机（匹配 {len(exact)}/{len(devices)} 台）")
    else:
        available = ",".join(dict.fromkeys(str(device.get("openharmonySdk")) for device in devices))
        on_log(f"[warn] 无 API{api_level} 同版本真机，已放宽到兼容设备（可用 API：{available or '未知'}）")
    ranked = rank_devices(exact or devices)
    idle = sum(int(device.get("idleDeviceCount") or 0) > 0 for device in ranked)
    on_log(f"真机候选 {len(ranked)} 台（空闲 {idle} 台，可排队 {len(ranked) - idle} 台），空闲优先逐台尝试提交")
    return ranked


QUOTA_DEVICE_FIELDS = ("alias", "deviceKind", "groupId", "harmonySdk", "hosVersion",
                       "openharmonySdk", "resolution", "typeAlias")
SUBMIT_DEVICE_FIELDS = ("groupId", "deviceType", "deviceKind", "resolution", "emuiVersion", "hosVersion",
                        "harmonySdk", "chargeMode", "freeLimitedTimes", "rooted", "typeAlias",
                        "openharmonySdk", "alias", "openharmonyVersion")


def _device_for_quota(device):
    result = {key: device.get(key) for key in QUOTA_DEVICE_FIELDS}
    for key, default in (("chargeMode", 0), ("emuiVersion", ""), ("freeLimitedTimes", False), ("rooted", 0)):
        result[key] = device.get(key, default)
    return result


def _device_for_submit(device):
    result = {key: device.get(key) for key in SUBMIT_DEVICE_FIELDS if key != "deviceType"}
    result["deviceType"] = device.get("type")
    result["propertySwitch"] = 1
    for key, default in (("chargeMode", 0), ("emuiVersion", ""), ("freeLimitedTimes", False), ("rooted", 0)):
        result[key] = device.get(key, default)
    return result


def _timestamp_name():
    return datetime.now().strftime("%Y%m%d%H%M%S")


def submit_with_device_fallback(client, app_info, candidates, settings, task_name="", task_name_label="",
                                app_profile=None, on_log=print, sleep=time.sleep):
    last_error = None
    for index, device in enumerate(candidates):
        label = str(device.get("typeAlias") or device.get("alias") or device.get("type") or "未知机型")
        try:
            payload = {"testCategoryLists": settings["testCategories"],
                       "deviceParamLists": [[_device_for_quota(device)]], "appId": app_info["id"]}
            quota = (client.predict_confirm(payload).get("data") or {})
            on_log(f"配额预检: 免费设备 {quota.get('freeDeviceNum')}/{quota.get('totalDeviceNum')}，"
                   f"预计占用免费额度 {quota.get('predictFreeQuota')} 分钟，余额充足={quota.get('amountEnough')}")
        except Exception as error:
            on_log(f"[warn] 配额预检失败（继续提交）: {error}")
            quota = None
        if quota and quota.get("amountEnough") is False:
            raise RuntimeError(f"配额不足，停止提交（剩余免费额度 {quota.get('freeAmount', '?')} 分钟，"
                               f"余额 {quota.get('validAmount', '?')}）；请在 AGC 控制台确认云测试配额后重试")
        try:
            on_log(f"第 {index + 1}/{len(candidates)} 台尝试提交: {label}（空闲 {device.get('idleDeviceCount') or 0}，"
                   f"等待 {device.get('waitTime') or 0} 分钟）")
            name = str(task_name or f"{task_name_label or app_info.get('appName') or (app_profile or {}).get('bundleName') or 'app'}_{_timestamp_name()}")[:100]
            submit_payload = {"category": 1, "thirdClass": settings["appClass"], "taskName": name,
                              "testCategoryLists": settings["testCategories"], "taskType": settings["taskType"],
                              "testItem": settings["testItem"],
                              "deviceParamLists": [[_device_for_submit(device)] for _ in settings["testCategories"]],
                              "appId": app_info["id"], "timeSpan": "0", "packageRank": True,
                              "apiLevels": [app_info["geApiLevel"]], "agcOpenHarmonyTask": True,
                              "appType": app_info["appType"]}
            group_id = client.submit_task(submit_payload)
            on_log(f"任务已提交: taskGroupId={group_id}（{name}，1 台真机）")
            return {"taskGroupId": group_id, "taskName": name, "taskType": settings["taskType"],
                    "testCategories": settings["testCategories"],
                    "devices": [{key: device.get(key) for key in ("type", "alias", "typeAlias", "hosVersion", "groupId")}],
                    "submitPayload": submit_payload, "submittedAt": _iso()}
        except Exception as error:
            last_error = error
            on_log(f"[warn] {label} 提交失败: {error}")
            if index < len(candidates) - 1:
                sleep(5)
                on_log("尝试下一台候选真机...")
    raise RuntimeError(f"全部 {len(candidates)} 台候选真机提交均失败，最后一次错误: {last_error}")


def submit_cloud_test_for_project(config, project_dir="", app_path="", case_name="", task_name="",
                                  task_name_label="", out_dir="", on_log=print, client=None, settings=None,
                                  sleep=time.sleep):
    settings = settings or load_config({"config": config})
    started_at = datetime.now(timezone.utc)
    output = Path(out_dir) if out_dir else (Path(config["execution"]["outputRoot"]) / "cloudtest" /
                                       f"{_timestamp_name()}_{uuid4().hex[:8]}")
    output.mkdir(parents=True, exist_ok=True)
    result_path = output / "cloudtest-result.json"
    result = {"schemaVersion": "cloudtest-run-v1", "status": "running", "case": case_name,
              "projectDir": project_dir, "outputDir": str(output), "startedAt": _iso(started_at), "error": ""}

    def persist():
        _atomic_json(result_path, result)

    persist()
    try:
        client = client or CloudTestClient(settings)
        client.refresh_auth()
        on_log("登录态已 refresh 轮换（仅本次运行内生效）")
        prepared = prepare_app_artifact(project_dir, app_path, settings, output,
                                        output / "build-console.log", on_log)
        result["app"] = prepared["app"]
        if prepared["build"]:
            result["build"] = prepared["build"]
        persist()
        package = digest(prepared["appPath"])
        result["app"] = {**result["app"], "fileName": package["fileName"], "path": prepared["appPath"],
                         "fileSize": package["fileSize"], "sha256": package["sha256"]}
        persist()
        bundle_name = prepared["app"].get("bundleName") or (prepared["appProfile"] or {}).get("bundleName") or ""
        existing = query_existing_packages(client, bundle_name, on_log)
        upload, app_info = upload_and_analyze_app(client, package, len(existing), settings, on_log)
        result["upload"] = upload
        persist()
        if bundle_name and app_info.get("packageName") and app_info["packageName"] != bundle_name:
            on_log(f"[warn] 云端解析包名 {app_info['packageName']} 与本地 bundleName {bundle_name} 不一致")
        candidates = select_cloud_devices(client, app_info, settings, on_log)
        task = submit_with_device_fallback(client, app_info, candidates, settings, task_name,
                                           task_name_label, prepared["appProfile"], on_log, sleep)
        result["task"] = task
        persist()
        return {"client": client, "settings": settings, "result": result,
                "resultPath": str(result_path), "startedAt": started_at}
    except KeyboardInterrupt as error:
        result.update({"status": "interrupted", "error": str(error) or "云测试执行被中断", "finishedAt": _iso()})
        persist()
        raise
    except Exception as error:
        result.update({"status": "failed", "error": str(error), "finishedAt": _iso()})
        persist()
        raise


def finish_cloud_test_polling(submission, on_log=print, sleep=time.sleep):
    client = submission["client"]
    settings = submission["settings"]
    result = submission["result"]
    path = Path(submission["resultPath"])
    started_at = submission["startedAt"]
    task = result["task"]

    def persist():
        _atomic_json(path, result)

    try:
        def update(group, polls):
            result["polling"] = {"taskGroup": group, "polls": polls, "lastPolledAt": _iso()}
            persist()

        polling = poll_task_group(client, task["taskGroupId"], settings, on_log, update, sleep)
        if not polling["finished"]:
            result.update({"status": "timed_out", "error":
                           f"等待云测试完成超时（{settings['taskTimeoutSec']} 秒），任务组 {task['taskGroupId']} 仍未结束；可稍后在 AGC 控制台查看"})
        else:
            result.update(final_status(polling["taskGroup"]))
            try:
                category = (task.get("testCategories") or [{}])[0].get("category") or 24
                report = fetch_task_report(client, task["taskGroupId"], category)
                html_path = write_cloudtest_html_report(result, report, result["outputDir"])
                result["report"] = {"htmlPath": html_path, "fetchedAt": _iso(),
                                    "summary": summarize_report(report)}
                if report["errors"]:
                    result["report"]["dataErrors"] = report["errors"]
            except Exception as error:
                result["report"] = {"htmlPath": "", "fetchedAt": _iso(), "error": str(error)}
                on_log(f"[warn] 云测试报告页生成失败: {error}")
            group = polling["taskGroup"]
            on_log("===== 云测试结果 =====")
            on_log(f"任务组: {task['taskGroupId']}（{task['taskName']}）")
            on_log(f"状态: {STATUS_LABELS.get(group.get('status'), group.get('status'))}"
                   f"（status={group.get('status')} resultStatus={group.get('resultStatus')}）")
            on_log(f"结果文件: {path}")
            if result["report"].get("htmlPath"):
                on_log(f"结果页面: {result['report']['htmlPath']}")
        persist()
        return result
    except KeyboardInterrupt as error:
        result.update({"status": "interrupted", "error": str(error) or "云测试执行被中断"})
        persist()
        raise
    except Exception as error:
        result.update({"status": "failed", "error": str(error)})
        persist()
        raise
    finally:
        result["finishedAt"] = _iso()
        result["elapsedSec"] = round((datetime.now(timezone.utc) - started_at).total_seconds())
        persist()


def run_cloud_test(config, project_dir="", app_path="", case_name="", task_name="", task_name_label="",
                   out_dir="", on_log=print, client=None, settings=None, sleep=time.sleep):
    submission = submit_cloud_test_for_project(config, project_dir, app_path, case_name, task_name,
                                               task_name_label or (Path(project_dir).name if project_dir else ""),
                                               out_dir, on_log, client, settings, sleep)
    return finish_cloud_test_polling(submission, on_log, sleep)

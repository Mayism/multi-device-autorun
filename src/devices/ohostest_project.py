"""ohosTest case metadata, project discovery and execution configuration."""

import json
from pathlib import Path
import re

from pyautorun.devices.json5_lite import read_loose_json5


AA_TEST_CASE_TIMEOUT_MS = 15000
TARGET = re.compile(r"^[A-Za-z0-9_.:-]+$")


def _required(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} is required.")
    return value.strip()


def _array(value, label):
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"{label} must be an array.")
    return [_required(item, f"{label}[{index}]") for index, item in enumerate(value)]


def _inside(root, path):
    root = Path(root).resolve()
    path = Path(path).resolve()
    return path == root or root in path.parents


def load_case_metadata(case_dir):
    case = Path(case_dir).resolve()
    path = case / "metadata.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"metadata.json 必须是对象: {path}")
    platform = raw.get("platform", "native")
    if platform not in ("native", "web", "rn", "flutter"):
        raise ValueError(f"case_platform_unsupported: {platform}")
    case_id = _required(raw.get("case_id"), "metadata.case_id")
    base_name = _required(raw.get("base_project"), "metadata.base_project")
    base = (case / base_name).resolve()
    if not _inside(case, base) or not base.is_dir():
        raise ValueError(f"case_base_project_not_found: {base_name}")
    files = {}
    for field in ("test_patch", "golden_patch"):
        relative = _required(raw.get(field), f"metadata.{field}")
        target = (case / relative).resolve()
        if not _inside(case, target) or not target.is_file():
            raise ValueError(f"patch_file_missing: {field} {relative}")
        files[field] = str(target)
    timeout = raw.get("test_case_timeout_ms", AA_TEST_CASE_TIMEOUT_MS)
    if not isinstance(timeout, int) or isinstance(timeout, bool) or timeout <= 0:
        raise ValueError("metadata.test_case_timeout_ms must be a positive integer.")
    suites = raw.get("device_test_suites")
    if suites is not None:
        if not isinstance(suites, dict) or not suites:
            raise ValueError("metadata.device_test_suites must contain at least one device.")
        for device, items in suites.items():
            if not isinstance(items, list):
                raise ValueError(f"metadata.device_test_suites.{device} must be an array.")
            for index, item in enumerate(items):
                if not isinstance(item, dict):
                    raise ValueError(f"metadata.device_test_suites.{device}[{index}] must be an object.")
                _required(item.get("suite"), f"metadata.device_test_suites.{device}[{index}].suite")
    enabled = raw.get("enabled_devices")
    if enabled is not None:
        enabled = list(dict.fromkeys(_array(enabled, "metadata.enabled_devices")))
        if not enabled:
            raise ValueError("metadata.enabled_devices must contain at least one device.")
    mapping = raw.get("device_hap_modules")
    if mapping is not None:
        if not isinstance(mapping, dict) or not mapping or any(key not in ("phone", "tablet", "pc") or
           not isinstance(value, str) or not value.strip() for key, value in mapping.items()):
            raise ValueError("metadata.device_hap_modules supports only nonempty phone, tablet, and pc modules.")
    isolate = raw.get("bundle_name_isolation")
    if isolate is not None and not isinstance(isolate, bool):
        raise ValueError("metadata.bundle_name_isolation must be a boolean.")
    rn = raw.get("rn_build")
    if rn is not None:
        if platform != "rn" or not isinstance(rn, dict):
            raise ValueError('metadata.rn_build is only valid when platform is "rn".')
        commands = _array(rn.get("bundle_commands"), "metadata.rn_build.bundle_commands")
        if not commands:
            raise ValueError("metadata.rn_build.bundle_commands must be a non-empty array.")
    return {"caseId": case_id, "caseDir": str(case), "baseProject": str(base),
            "platform": platform, "testPatch": files["test_patch"], "goldenPatch": files["golden_patch"],
            "testCaseTimeoutMs": timeout, "failToPass": _array(raw.get("fail_to_pass"), "metadata.fail_to_pass"),
            "passToPass": _array(raw.get("pass_to_pass"), "metadata.pass_to_pass"),
            "deviceTestSuites": suites, "enabledDevices": enabled, "deviceHapModules": mapping,
            "bundleNameIsolation": isolate, "rnBuild": rn}


def select_devices(metadata, machine, requested=None):
    machine_ids = {item["id"] for item in machine["devices"]}
    suites = metadata.get("deviceTestSuites")
    skipped_pc = [name for name in suites or {} if name.strip().lower().replace("-", "").replace("_", "") in ("pc", "2in1")]
    if suites:
        devices = [name for name in suites if name not in skipped_pc]
        overrides = {name: list(dict.fromkeys(item["suite"] for item in suites[name])) for name in devices}
        if any(not overrides[name] for name in devices):
            raise ValueError("metadata device has no suites")
        run_all = False
    else:
        devices = metadata.get("enabledDevices") or [item["id"] for item in machine["devices"]]
        overrides = {}
        run_all = True
    for name in devices:
        if name not in machine_ids:
            raise ValueError(f"metadata device {name} is missing in machine config.")
    if requested:
        selected = list(dict.fromkeys(requested))
        if skipped_pc:
            selected = [name for name in selected if name not in skipped_pc]
        if any(name not in devices for name in selected):
            raise ValueError("case device is not enabled by metadata or machine config")
        devices = selected
    return {"devices": devices, "deviceSuiteOverrides": {key: overrides[key] for key in devices if key in overrides},
            "runAllTests": run_all, "skippedDevices": skipped_pc}


def execution_groups(metadata, selection):
    mapping = metadata.get("deviceHapModules")
    if not mapping:
        return [{"module": None, "selection": selection}]
    groups = {}
    for device in selection["devices"]:
        deployment = "tablet" if device == "tablet" else "pc" if device in ("pc", "2in1") else "phone"
        module = mapping.get(deployment)
        if not module:
            raise ValueError(f"metadata.device_hap_modules.{deployment} is required for device {device}.")
        group = groups.setdefault(module, {"module": module, "selection": {"devices": [],
                                 "deviceSuiteOverrides": {}, "runAllTests": selection["runAllTests"]}})
        group["selection"]["devices"].append(device)
        if device in selection["deviceSuiteOverrides"]:
            group["selection"]["deviceSuiteOverrides"][device] = selection["deviceSuiteOverrides"][device]
    return list(groups.values())


def discover_project_info(project_dir, requested_module=None):
    project = Path(project_dir)
    profile = read_loose_json5(project / "build-profile.json5")
    app = read_loose_json5(project / "AppScope" / "app.json5")
    product = ((profile.get("app") or {}).get("products") or [{}])[0].get("name") or "default"
    modules = profile.get("modules") or []
    def applies(module):
        targets = module.get("targets") or []
        return not targets or any(product in (item.get("applyToProducts") or []) for item in targets)
    matches = []
    for module in modules:
        name = str(module.get("name") or "").strip()
        src = str(module.get("srcPath") or "").removeprefix("./").strip()
        if not name or not src or not applies(module):
            continue
        hvigor = project / src / "hvigorfile.ts"
        if not hvigor.is_file():
            continue
        if re.search(r"\bhapTasks\b", hvigor.read_text(encoding="utf-8")):
            matches.append((name, src, module))
    if requested_module:
        matches = [item for item in matches if item[0] == requested_module]
    if len(matches) != 1:
        raise ValueError(f"project_hap_module_{'not_found' if not matches else 'ambiguous'}: {project}")
    name, src, _ = matches[0]
    test_config = read_loose_json5(project / src / "src" / "ohosTest" / "module.json5")
    bundle_name = (app.get("app") or {}).get("bundleName")
    if not bundle_name:
        raise ValueError("app.bundleName is required")
    shared = []
    for module in modules:
        shared_name = str(module.get("name") or "").strip()
        shared_src = str(module.get("srcPath") or "").removeprefix("./").strip()
        if not shared_name or not shared_src or not applies(module):
            continue
        config_file = project / shared_src / "src" / "main" / "module.json5"
        if not config_file.is_file() or (read_loose_json5(config_file).get("module") or {}).get("type") != "shared":
            continue
        package = read_loose_json5(project / shared_src / "oh-package.json5")
        shared.append({"name": shared_name, "srcPath": shared_src,
                       "packageName": package.get("name") or shared_name,
                       "dependencies": list((package.get("dependencies") or {}).keys()),
                       "outputDir": str(project / shared_src / "build" / product / "outputs" / product)})
    ordered = []
    def visit(item):
        if item in ordered:
            return
        for dependency in item["dependencies"]:
            match = next((candidate for candidate in shared if candidate["packageName"] == dependency), None)
            if match:
                visit(match)
        ordered.append(item)
    for item in shared:
        visit(item)
    output = Path(src) / "build" / product / "outputs"
    return {"product": product, "moduleName": name, "moduleSrcPath": src,
            "bundleName": str(bundle_name), "testModuleName": (test_config.get("module") or {}).get("name") or f"{name}_test",
            "sharedModules": ordered,
            "appHap": str(output / product / f"{name}-{product}-unsigned.hap"),
            "testHap": str(output / "ohosTest" / f"{name}-ohosTest-unsigned.hap")}


def load_execution_config(project_dir, machine, metadata, module=None):
    project = Path(project_dir)
    platform = metadata["platform"]
    if platform == "rn":
        project = project / "harmony"
    elif platform == "flutter":
        project = project / "ohos"
    if not project.is_dir():
        raise ValueError(f"case_{platform}_project_invalid: {project}")
    paths = machine.get("paths") or {}
    for key in ("hvigorw", "hdc", "emulatorBin", "emulatorDeployedDir"):
        _required(paths.get(key), f"config.paths.{key}")
    devices = machine.get("devices")
    if not isinstance(devices, list) or not devices:
        raise ValueError("config.devices must contain at least one device.")
    for index, device in enumerate(devices):
        if not device.get("id") or not TARGET.fullmatch(str(device.get("target") or "")) or ":" not in device["target"]:
            raise ValueError(f"config.devices[{index}].target is invalid.")
    info = discover_project_info(project, module or machine.get("module"))
    artifacts = machine.get("artifacts") or {}
    app_hap = artifacts.get("appHap") or info["appHap"]
    test_hap = artifacts.get("testHap") or info["testHap"]
    build = machine.get("build") or {}
    return {"project": str(project), "product": machine.get("product") or info["product"],
            "module": module or machine.get("module") or info["moduleName"],
            "moduleSrcPath": info["moduleSrcPath"], "sharedModules": info["sharedModules"],
            "bundleName": machine.get("bundleName") or info["bundleName"],
            "testModule": machine.get("testModule") or info["testModuleName"],
            "testRunner": machine.get("testRunner") or "OpenHarmonyTestRunner",
            "testClass": machine.get("testClass") or "", "testCaseTimeoutMs": metadata["testCaseTimeoutMs"],
            "timeoutMs": machine.get("timeoutMs") or 120000,
            "build": {"mode": build.get("mode") or "project", "appTask": build.get("appTask") or "assembleApp",
                      "testTask": build.get("testTask") or "ohosTest@PackageHap"},
            "paths": {**paths, "ohpm": paths.get("ohpm") or "ohpm"},
            "artifacts": {"appHap": str(project / app_hap) if not Path(app_hap).is_absolute() else str(app_hap),
                          "testHap": str(project / test_hap) if not Path(test_hap).is_absolute() else str(test_hap)},
            "devices": devices, "platform": platform,
            "rnBundleCommands": (metadata.get("rnBuild") or {}).get("bundle_commands") or []}

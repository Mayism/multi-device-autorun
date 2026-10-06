"""Temporary HarmonyOS device declarations and per-phase bundle isolation."""

from contextlib import contextmanager
import json
from pathlib import Path
import re
import time

from pyautorun.devices.json5_lite import read_loose_json5


DEVICE_TYPES = {"phone": "phone", "wide_fold": "phone", "foldable": "phone",
                "tablet": "tablet", "pc": "2in1", "2in1": "2in1", "tv": "tv",
                "wearable": "wearable", "car": "car"}


def rewrite_bundle_name(project, name):
    if len(name.encode("utf-8")) > 127:
        raise ValueError("bundle_name_too_long")
    path = Path(project) / "AppScope" / "app.json5"
    original = path.read_text(encoding="utf-8")
    updated, count = re.subn(r'("bundleName"\s*:\s*")[^"]*(")',
                             lambda match: match.group(1) + name + match.group(2), original, count=1)
    if count != 1:
        raise ValueError(f"bundle_name_not_found: {path}")
    path.write_text(updated, encoding="utf-8")


def isolated_bundle_name(original, phase):
    return f"{original}.swe" if phase == "swe" else f"{original}.answer.{int(time.time() * 1000)}"


@contextmanager
def temporary_device_types(config, device_ids):
    required = list(dict.fromkeys(DEVICE_TYPES[device] for device in device_ids))
    project = Path(config["project"])
    module_sources = [config["moduleSrcPath"],
                      *(item["srcPath"] for item in config.get("sharedModules") or [])]
    paths = [project / source / "src" / "main" / "module.json5" for source in module_sources]
    originals = {}
    declared = []
    try:
        for index, path in enumerate(paths):
            original = path.read_text(encoding="utf-8")
            data = read_loose_json5(path)
            types = (data.get("module") or {}).get("deviceTypes")
            if not isinstance(types, list) or any(not isinstance(item, str) for item in types):
                raise ValueError(f"case_device_type_compatibility_invalid_module: {path}")
            if index == 0:
                declared = list(types)
            missing = [item for item in required if item not in types]
            if missing:
                originals[path] = original
                data["module"]["deviceTypes"] = [*types, *missing]
                path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        yield {"modulePath": str(paths[0]), "declaredDeviceTypes": declared,
               "requiredByDevice": {device: DEVICE_TYPES[device] for device in device_ids},
               "injectedDeviceTypes": [item for item in required if item not in declared]}
    finally:
        for path, original in originals.items():
            path.write_text(original, encoding="utf-8")


def apply_answer_device_type_checks(execution, assessment):
    for device in execution["devices"]:
        device_type = assessment["requiredByDevice"].get(device["id"])
        if not device_type:
            continue
        declared = device_type in assessment["declaredDeviceTypes"]
        passed = 1 if declared else 0
        check = {"suiteClass": "ModuleDeviceTypeCompatibility",
                 "status": "passed" if declared else "failed", "testsRun": 1,
                 "failures": 1 - passed, "errors": 0, "passes": passed, "ignored": 0,
                 "reportCode": 0 if declared else -1, "ok": declared,
                 "testCases": [{"name": f"should_declare_{device_type}_device_type",
                                "status": "passed" if declared else "failed",
                                "statusCode": 0 if declared else -2,
                                **({"message": f'{assessment["modulePath"]} module.deviceTypes does not include "{device_type}"; the runner temporarily injected it for test execution.'} if not declared else {})}]}
        device["suiteResults"].append(check)
        device["testsRun"] += 1
        device["failures"] += 1 - passed
        device["passes"] += passed
        if not declared and device["status"] != "blocked":
            device["status"] = "failed"
    execution["status"] = "completed" if execution["devices"] and all(
        device["status"] == "passed" for device in execution["devices"]) else "failed"
    return execution

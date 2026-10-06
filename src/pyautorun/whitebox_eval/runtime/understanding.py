"""Python task-understanding inputs and deterministic normalization."""

import json
import os
from pathlib import Path
import re

from pyautorun.whitebox_eval.rules.rule_evidence import _filter_patch, _ignored_case_file


IGNORED_DIRS = {".git", ".hvigor", ".idea", ".vscode", "build", "dist",
                "node_modules", "oh_modules"}


def project_structure(root_path):
    root = Path(root_path)
    files = []
    top = []
    omitted = 0

    def visit(directory, depth):
        nonlocal omitted
        if depth > 8 or len(files) >= 500:
            omitted += 1
            return
        try:
            entries = sorted(os.scandir(directory), key=lambda entry: entry.name)
        except OSError:
            entries = []
        for entry in entries:
            if depth == 0:
                top.append(entry.name)
            if entry.name in IGNORED_DIRS:
                continue
            if entry.is_dir(follow_symlinks=False):
                visit(entry.path, depth + 1)
            elif entry.is_file(follow_symlinks=False):
                relative = Path(entry.path).relative_to(root).as_posix()
                if not _ignored_case_file(relative) and len(files) < 500:
                    files.append(relative)
                else:
                    omitted += 1

    visit(root, 0)
    modules = list(dict.fromkeys(file.removesuffix("/src/main/module.json5") if file != "src/main/module.json5"
                                 else "." for file in files
                                 if file.endswith("/src/main/module.json5") or file == "src/main/module.json5"))
    hints = (["HarmonyOS 模块: " + ", ".join(modules)] if modules else [])
    if any(file.endswith(".ets") for file in files):
        hints.append("技术栈: ArkTS/ETS 页面与组件实现")
    if any("/viewmodels/" in file for file in files):
        hints.append("分层: 存在 viewmodels 目录，需保持状态管理分层")
    if any("/components/" in file for file in files):
        hints.append("分层: 存在 components 目录，需复用组件边界")
    if any("/resources/" in file for file in files):
        hints.append("资源: 存在 resources 目录，需遵循资源引用约束")
    return {"rootPath": str(root_path), "topLevelEntries": sorted(set(top)),
            "modulePaths": modules, "implementationHints": hints, "omittedFileCount": omitted}


def patch_summary(text):
    if not text.strip():
        return {"hasPatch": False, "changedFiles": [], "affectedRoots": [],
                "addedLines": 0, "deletedLines": 0, "changeTypes": [],
                "intrusionLevel": "none", "rawPatchLength": 0}
    files = []
    types = []
    added = deleted = 0
    for line in re.split(r"\r?\n", text):
        match = re.match(r"^diff --git a/(.+?) b/(.+)$", line)
        if match:
            files.append(match.group(2))
        match = re.match(r"^\+\+\+ b/(.+)$", line)
        if match and match.group(1) != "/dev/null":
            files.append(match.group(1))
        if line == "new file mode" or line.startswith("new file mode "):
            types.append("added_file")
        elif line == "deleted file mode" or line.startswith("deleted file mode "):
            types.append("deleted_file")
        elif line.startswith(("rename from ", "rename to ")):
            types.append("renamed_file")
        elif line.startswith("+") and not line.startswith("+++"):
            added += 1
        elif line.startswith("-") and not line.startswith("---"):
            deleted += 1
    if added or deleted:
        types.append("modified")
    files = list(dict.fromkeys(files))
    changes = added + deleted
    intrusion = ("none" if not files else "low" if len(files) <= 2 and changes <= 80 else
                 "medium" if len(files) <= 8 and changes <= 300 else "high")
    return {"hasPatch": True, "changedFiles": files,
            "affectedRoots": list(dict.fromkeys(file.split("/")[0] for file in files)),
            "addedLines": added, "deletedLines": deleted,
            "changeTypes": list(dict.fromkeys(types)), "intrusionLevel": intrusion,
            "rawPatchLength": len(text)}


def read_patch_summary(path):
    if not path:
        return patch_summary("")
    try:
        content = Path(path).read_text(encoding="utf-8")
    except OSError:
        content = ""
    return patch_summary(_filter_patch(content))


def _list(value, limit):
    return list(dict.fromkeys(item.strip() for item in value if item.strip()))[:limit]


def infer_cross_device(input_data):
    text = "\n".join([input_data["promptText"], *input_data["projectStructure"]["implementationHints"],
                      *input_data["patchSummary"]["changedFiles"],
                      *input_data["patchSummary"]["changeTypes"]]).lower()
    patterns = (r"多设备|多端|多屏|跨设备|跨端|一多|手机.*平板|平板.*手机|折叠屏|智慧屏|手表|车机|"
                r"响应式|自适应|断点|横竖屏|窗口尺寸|不同设备形态")
    if re.search(patterns, text):
        return {"applicability": "involved", "confidence": "medium",
                "reasons": ["输入信息出现多设备、多屏或设备形态适配诉求"]}
    return {"applicability": "not_involved", "confidence": "high",
            "reasons": ["需求未出现多设备、多屏或设备形态适配要求"]}


def parse_constraint_summary(raw):
    value = json.loads(raw) if isinstance(raw, str) else raw
    required = {"explicitConstraints", "contextualConstraints", "implicitConstraints",
                "classificationHints", "crossDeviceAdaptation"}
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError("Task understanding output fields are invalid")
    result = {}
    for key, limit in (("explicitConstraints", 12), ("contextualConstraints", 16),
                       ("implicitConstraints", 16), ("classificationHints", 8)):
        items = value[key]
        if not isinstance(items, list) or any(not isinstance(item, str) or not item for item in items):
            raise ValueError(f"{key} must be a nonempty string array")
        result[key] = _list(items, limit)
    cross = value["crossDeviceAdaptation"]
    if (not isinstance(cross, dict) or set(cross) != {"applicability", "confidence", "reasons"} or
        cross["applicability"] not in ("involved", "not_involved", "uncertain") or
        cross["confidence"] not in ("high", "medium", "low") or
        not isinstance(cross["reasons"], list) or not 1 <= len(cross["reasons"]) <= 5 or
        any(not isinstance(reason, str) or not reason for reason in cross["reasons"])):
        raise ValueError("crossDeviceAdaptation is invalid")
    if cross["applicability"] == "uncertain" and cross["confidence"] != "low":
        raise ValueError("crossDeviceAdaptation uncertain requires low confidence")
    result["crossDeviceAdaptation"] = {**cross, "reasons": _list(cross["reasons"], 5)}
    return result

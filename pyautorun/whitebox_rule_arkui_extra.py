"""ArkUI routerMap and bindSheet supplemental rules."""

import json
import re

from .whitebox_rule_text import _mask_comments, _mask_strings


def _base(rule, result, conclusion):
    return {"rule_id": rule["rule_id"], "rule_source": rule["rule_source"], "result": result,
            "conclusion": conclusion, "matchedFiles": []}


def _normalize(path):
    return re.sub(r"^(?:workspace|generated)/", "", path).replace("\\", "/")


def _module_root(path):
    normalized = _normalize(path)
    marker = "/src/main/module.json5"
    return normalized[:-len(marker)] if normalized.endswith(marker) else ""


def _page_path(module, page):
    normalized = _normalize(page).lstrip("/")
    root = _module_root(module)
    extension = normalized if normalized.endswith(".ets") else normalized + ".ets"
    if normalized.startswith("src/main/"):
        return (root + "/" if root else "") + extension
    if root and not normalized.startswith(root + "/"):
        return root + "/" + extension
    return extension


def _patch_route_targets(evidence, module, profile):
    added = set()
    removed = set()
    current = None
    for line in re.split(r"\r?\n", evidence.get("patchText") or ""):
        match = re.match(r"^diff --git a/.+? b/(.+)$", line)
        if match:
            current = _normalize(match.group(1))
            continue
        match = re.match(r"^\+\+\+ b/(.+)$", line)
        if match:
            current = _normalize(match.group(1))
            continue
        if current != _normalize(profile):
            continue
        target = added if line.startswith("+") and not line.startswith("+++") else removed if line.startswith("-") and not line.startswith("---") else None
        if target is None:
            continue
        for match in re.finditer(r'''["']pageSourceFile["']\s*:\s*["']([^"']+)["']''', line):
            target.add(_page_path(module, match.group(1)))
    return added - removed


def _route_navdestination(rule, evidence):
    files = evidence.get("allWorkspaceFiles")
    if files is None:
        files = evidence["workspaceFiles"]
    by_path = {_normalize(file["relativePath"]): file for file in files}
    modules = []
    for file in files:
        if not _normalize(file["relativePath"]).endswith("/src/main/module.json5"):
            continue
        match = re.search(r'''(?:^|[,\{]\s*)["']?routerMap["']?\s*:\s*["']\$profile:([^"']+)["']''',
                          file["content"])
        if match and match.group(1).strip():
            modules.append((file, match.group(1).strip()))
    if not modules:
        return _base(rule, "不涉及", "工程未配置 routerMap，规则不涉及。")
    invalid = []
    failed = []
    inspected = []
    changed = {_normalize(path) for path in evidence.get("changedFiles", [])}
    for module, profile_name in modules:
        module_path = module["relativePath"]
        root = _module_root(module_path)
        profile_path = (root + "/" if root else "") + f"src/main/resources/base/profile/{profile_name}.json"
        profile = by_path.get(_normalize(profile_path))
        if not profile:
            invalid.append(profile_path)
            continue
        try:
            parsed = json.loads(profile["content"])
        except (ValueError, TypeError):
            invalid.append(profile_path)
            continue
        entries = parsed.get("routerMap") if isinstance(parsed, dict) else None
        entries = [item for item in entries if isinstance(item, dict)] if isinstance(entries, list) else []
        added = _patch_route_targets(evidence, module_path, profile_path)
        for entry in entries:
            if not isinstance(entry.get("pageSourceFile"), str):
                continue
            page = _page_path(module_path, entry["pageSourceFile"])
            if changed and page not in changed and _normalize(module_path) not in changed and page not in added:
                continue
            inspected.append(page)
            target = by_path.get(_normalize(page))
            if not target or not re.search(r"\bNavDestination\s*\(", target["content"]):
                failed.append(page)
    if invalid:
        return {**_base(rule, "不满足", "配置了 routerMap，但 profile 缺失或不可读：" + ", ".join(invalid) + "。"),
                "matchedFiles": invalid}
    if failed:
        return {**_base(rule, "不满足", "routerMap 指向的页面未使用 NavDestination：" + ", ".join(failed) + "。"),
                "matchedFiles": failed}
    if not inspected:
        return _base(rule, "不涉及", "本次变更未涉及 routerMap 配置或其指向页面。")
    return {**_base(rule, "满足", "routerMap 指向页面均使用 NavDestination。"),
            "matchedFiles": inspected}


def _multi_bind_sheet(rule, evidence):
    locations = []
    files = [file for file in evidence["workspaceFiles"] if file["relativePath"].endswith(".ets")]
    for file in files:
        sanitized = _mask_strings(_mask_comments(file["content"]))
        in_chain = False
        for line_number, line in enumerate(sanitized.split("\n"), 1):
            trimmed = line.strip()
            if not trimmed:
                continue
            if not trimmed.startswith("."):
                in_chain = False
            count = len(re.findall(r"\.\s*bindSheet\s*\(", line))
            if count:
                if in_chain or count > 1:
                    locations.append(f'{file["relativePath"]}:{line_number}')
                in_chain = True
    if locations:
        return {**_base(rule, "不满足", "同一组件链式调用了多个 bindSheet：" +
                        ", ".join(locations[:5]) + "。"),
                "matchedFiles": list(dict.fromkeys(re.sub(r":\d+$", "", item) for item in locations)),
                "matchedLocations": locations}
    if not any(re.search(r"\bbindSheet\s*\(", _mask_strings(_mask_comments(file["content"])))
               for file in files):
        return _base(rule, "不涉及", "本次变更未涉及 bindSheet。")
    return _base(rule, "满足", "未发现同一组件链式调用多个 bindSheet。")


def evaluate_arkui_extra_rule(rule, evidence):
    check = rule["detector"]["config"].get("check")
    if check == "route_navdestination":
        return _route_navdestination(rule, evidence)
    if check == "multi_bindsheet_same_component":
        return _multi_bind_sheet(rule, evidence)
    return _base(rule, "未接入判定器", rule["summary"] + " 当前版本未接入静态判定器，需要 Agent 辅助判定。")

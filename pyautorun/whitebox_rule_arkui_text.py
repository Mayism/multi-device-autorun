"""Project and text level ArkUI static checks."""

import re

from .whitebox_arkui_values import (opaque_responsive, property_value, resolve_constants,
                                    responsive_expression)
from .whitebox_rule_arkui_components import base_result, with_matches, _instance_snippet


def _all_files(evidence):
    files = evidence.get("allWorkspaceFiles")
    return evidence["workspaceFiles"] if files is None else files


def _ets_files(evidence):
    return [file for file in _all_files(evidence) if file["relativePath"].endswith(".ets")]


def _web_files(evidence):
    return [file for file in _all_files(evidence)
            if re.search(r"\.(?:css|html?|js|ts|ets)$", file["relativePath"])]


def _line(content, index):
    return content[:max(0, index)].count("\n") + 1


def _line_of(content, text):
    index = content.find(text)
    return _line(content, index if index >= 0 else 0)


def _matches(files, pattern, flags=0):
    compiled = re.compile(pattern, flags)
    result = []
    for file in files:
        content = file["content"]
        for match in compiled.finditer(content):
            snippet = re.sub(r"\s+", " ", content[match.start():match.start() + max(len(match.group()), 120)]).strip()[:240]
            result.append({"file": file["relativePath"], "line": _line(content, match.start()),
                           **({"snippet": snippet} if snippet else {})})
    return result


def _snippets(matches):
    return [item["snippet"] for item in matches if item.get("snippet")]


def _string_array(content, key):
    match = re.search(r'''["']?''' + re.escape(key) + r'''["']?\s*:\s*\[([^\]]*)\]''', content)
    return [item.group(1) for item in re.finditer(r'''["']([^"']+)["']''', match.group(1))] if match and match.group(1) else []


def _string_property(content, key):
    match = re.search(r'''["']?''' + re.escape(key) + r'''["']?\s*:\s*["']([^"']+)["']''', content)
    return match.group(1) if match else None


def _instance_locations(instances):
    return [{"file": item["filePath"], "line": item["line"]} for item in instances]


def _check_device_types(rule, evidence, _index):
    files = [file for file in _all_files(evidence)
             if re.search(r"(^|/)src/main/module\.json5$", file["relativePath"]) and
             _string_property(file["content"], "type") in ("entry", "feature")]
    if not files:
        return base_result(rule, "不涉及", "未发现 HAP 模块的 src/main/module.json5，规则不涉及。")
    by_file = [(file, _string_array(file["content"], "deviceTypes")) for file in files]
    aggregated = sorted(set(item for _, types in by_file for item in types))
    locations = [{"file": file["relativePath"], "line": _line_of(file["content"], "deviceTypes")}
                 for file in files]
    preliminary = {"inspectedFileCount": len(files), "aggregatedDeviceTypes": aggregated}
    if "phone" not in aggregated or "tablet" not in aggregated:
        return with_matches(base_result(rule, "不满足", "工程 HAP 模块 deviceTypes 汇总后缺少 phone 或 tablet。",
                                        preliminary), locations, ["aggregatedDeviceTypes=" + ",".join(aggregated)])
    return with_matches(base_result(rule, "满足", "工程 HAP 模块 deviceTypes 汇总后包含 phone 和 tablet。",
                                    preliminary), locations,
                        ["deviceTypes=" + ",".join(types) for _, types in by_file])


def _check_breakpoint_ranges(rule, evidence, index):
    paths = {file["relativePath"] for file in evidence["workspaceFiles"]}
    rows = [item for item in index["componentInstances"] if item["component"] == "GridRow" and
            item["filePath"] in paths]
    breakpoints = [(item, property_value(item, "breakpoints")) for item in rows]
    breakpoints = [(item, value) for item, value in breakpoints if value]
    opaque = [(item, value) for item, value in breakpoints if opaque_responsive(value["valueText"], index)]
    failed = [(item, value) for item, value in breakpoints if not opaque_responsive(value["valueText"], index) and
              not all(text in resolve_constants(value["valueText"], index)
                      for text in ("320vp", "600vp", "840vp", "1440vp"))]
    bad = [item for item in _matches(_ets_files(evidence),
                                     r"\b(?:xs|sm|md|lg|xl)\b[^;\n]{0,80}\b(300|500|768|800|900|1200|1280|1600)\b")
           if not re.search("register", item.get("snippet", ""), re.I)]
    preliminary = {"inspectedGridRowBreakpointCount": len(breakpoints)}
    if failed or bad:
        return with_matches(base_result(rule, "不满足", "断点边界未覆盖系统推荐值 320/600/840/1440。",
                                        preliminary), _instance_locations([item for item, _ in failed]) + bad,
                            ["breakpoints=" + value["valueText"] for _, value in failed] + _snippets(bad))
    if opaque:
        review = [{"rule_id": "breakpoint_ranges_standard", "file": item["filePath"],
                   "line": value["line"], "subject": item["component"],
                   "evidence": "breakpoints=" + value["valueText"],
                   "question": "请结合规则描述和源码上下文复核该 GridRow breakpoints 是否包含推荐断点 320vp/600vp/840vp/1440vp。"}
                  for item, value in opaque]
        return with_matches(base_result(rule, "未接入判定器",
                                        "GridRow breakpoints 使用静态层无法稳定解释的封装表达式，需要 Agent 复核。",
                                        {**preliminary, "reviewEvidence": review}),
                            [{"file": item["filePath"], "line": value["line"]} for item, value in opaque],
                            ["breakpoints=" + value["valueText"] for _, value in opaque])
    if not breakpoints and not bad:
        return base_result(rule, "不涉及", "未发现自定义断点边界或 GridRow breakpoints 配置，规则不涉及。")
    return with_matches(base_result(rule, "满足", "断点边界符合系统推荐值。", preliminary),
                        _instance_locations([item for item, _ in breakpoints]))


def _check_hardcoded_width(rule, evidence, _index):
    matches = [item for item in _matches(_ets_files(evidence),
                r"\b(?:screenWidth|windowWidth|contentWidth|width|vp)\b\s*(?:[<>]=?|===?)\s*(?:320|600|840|1440)\b|\b(?:320|600|840|1440)\b\s*(?:[<>]=?|===?)\s*\b(?:screenWidth|windowWidth|contentWidth|width|vp)\b")
               if not re.search(r"BreakpointSystem\.register|breakpoints\s*:", item.get("snippet", ""))]
    return (with_matches(base_result(rule, "不满足", "发现布局条件使用硬编码断点宽度比较。"), matches,
                         _snippets(matches)) if matches else
            base_result(rule, "满足", "未发现布局条件中使用硬编码断点宽度比较。"))


def _check_breakpoint_source(rule, evidence, _index):
    files = _ets_files(evidence)
    bad = _matches(files,
        r"\bonAreaChange\s*\([^)]*=>[\s\S]{0,300}\b(?:width|contentWidth)\b[\s\S]{0,120}\b(?:320|600|840|1440)\b|\bcalcBreakpoint\s*\([^)]*\)[\s\S]{0,240}\b(?:320|600|840|1440)\b|\b(?:currentBreakpoint|breakpoint)\b[\s\S]{0,160}\b(?:width|screenWidth|windowWidth|contentWidth)\b\s*(?:[<>]=?|===?)\s*(?:320|600|840|1440)\b|\b(?:width|screenWidth|windowWidth|contentWidth)\b\s*(?:[<>]=?|===?)\s*(?:320|600|840|1440)\b[\s\S]{0,160}\b(?:currentBreakpoint|breakpoint)\b", re.I)
    if bad:
        return with_matches(base_result(rule, "不满足", "发现通过组件宽度、窗口宽度或硬编码阈值推导当前断点。"), bad,
                            _snippets(bad))
    good = _matches(files, r"\b(?:WidthBreakpoint|currentBreakpoint|mediaquery|windowSizeChange|GridRow\s*\([^)]*breakpoints)")
    if not good:
        return base_result(rule, "不涉及", "未发现页面组件获取当前断点值的代码，规则不涉及。")
    return with_matches(base_result(rule, "满足", "断点来源使用系统断点、mediaquery、窗口监听或标准 GridRow。"),
                        good[:10])


def _check_listener_source(rule, evidence, _index):
    files = _ets_files(evidence)
    bad = [item for item in _matches(files, r"\b(?:foldStatusChange|orientation)\b")
           if re.search(r"breakpoint|WidthBreakpoint|screenWidth|windowWidth|currentBreakpoint",
                        item.get("snippet", ""), re.I)]
    if bad:
        return with_matches(base_result(rule, "不满足", "发现使用 foldStatusChange 或方向 API 驱动断点更新。"),
                            bad, _snippets(bad))
    good = _matches(files, r'''\b(?:windowSizeChange|mediaquery\.matchMediaSync|display\.on\s*\(\s*['"]change['"])''')
    if not good:
        return base_result(rule, "不涉及", "未发现断点监听注册，规则不涉及。")
    return with_matches(base_result(rule, "满足", "断点监听来源使用 windowSizeChange、mediaquery 或 display change。"),
                        good[:10])


def _check_listener_timing(rule, evidence, _index):
    files = _ets_files(evidence)
    listeners = _matches(files, r"\b(?:windowSizeChange|mediaquery\.matchMediaSync)\b")
    if not listeners:
        return base_result(rule, "不涉及", "未发现 windowSizeChange 或 mediaquery 断点监听，规则不涉及。")
    bad = _matches(files,
        r"\bon(?:Create|WindowStageCreate)\s*\([^)]*\)\s*\{[\s\S]{0,500}\b(?:windowSizeChange|mediaquery\.matchMediaSync)\b[\s\S]{0,500}\bloadContent\b")
    if bad:
        return with_matches(base_result(rule, "不满足", "发现断点监听在 loadContent 完成前注册。"), bad,
                            _snippets(bad))
    good = _matches(files,
        r"\b(?:loadContent\s*\([^)]*,\s*\([^)]*\)\s*=>[\s\S]{0,300}(?:windowSizeChange|mediaquery\.matchMediaSync)|aboutToAppear\s*\([^)]*\)\s*\{[\s\S]{0,300}(?:windowSizeChange|mediaquery\.matchMediaSync))")
    if good:
        return with_matches(base_result(rule, "满足", "断点监听在 loadContent 回调或页面 aboutToAppear 中注册。"),
                            good[:10])
    return with_matches(base_result(rule, "满足", "未发现断点监听早于 loadContent 注册的反模式。"), listeners[:10])


def _check_folder_fullscreen(rule, _evidence, index):
    instances = [item for item in index["componentInstances"] if item["component"] == "FolderStack"]
    if not instances:
        return base_result(rule, "不涉及", "未发现 FolderStack，规则不涉及。")
    def full(value):
        return bool(value and re.search(r'''['"]100%['"]|FULL|matchParent''', value, re.I))
    failed = [item for item in instances if not (
        property_value(item, "expandSafeArea") or
        (full((property_value(item, "width") or {}).get("valueText")) and
         full((property_value(item, "height") or {}).get("valueText"))))]
    if failed:
        spec = {"properties": ["width", "height"]}
        return with_matches(base_result(rule, "不满足", "FolderStack 未显式撑满全屏。"),
                            _instance_locations(failed), [_instance_snippet(item, spec) for item in failed])
    return with_matches(base_result(rule, "满足", "FolderStack 已显式撑满全屏。"),
                        _instance_locations(instances))


def _check_folder_upper_ids(rule, _evidence, index):
    instances = [item for item in index["componentInstances"] if item["component"] == "FolderStack"]
    configured = [(item, _string_array(item["argumentText"], "upperItems")) for item in instances]
    configured = [(item, names) for item, names in configured if names]
    if not configured:
        return base_result(rule, "不涉及", "未发现 FolderStack，规则不涉及。" if not instances else
                           "FolderStack 未配置 upperItems，规则不涉及。")
    failed = []
    for item, upper in configured:
        ids = {match.group(1) for instance in index["componentInstances"]
               if instance["filePath"] == item["filePath"]
               for prop in instance["properties"] if prop["name"] == "id"
               for match in re.finditer(r'''["']([^"']+)["']''', prop["argumentText"])}
        if any(name not in ids for name in upper):
            failed.append((item, upper))
    if failed:
        return with_matches(base_result(rule, "不满足", "FolderStack upperItems 存在未匹配的子组件 id。"),
                            _instance_locations([item for item, _ in failed]),
                            ["upperItems=" + ",".join(upper) for _, upper in failed])
    return with_matches(base_result(rule, "满足", "FolderStack upperItems 均有匹配子组件 id。"),
                        _instance_locations([item for item, _ in configured]))


def _hover_files(files):
    result = []
    for file in files:
        content = file["content"]
        if re.search(r"\b(?:FolderStack|FoldSplitContainer|upperItems|getCurrentFoldCreaseRegion)\b", content):
            result.append(file)
        elif re.search(r"\bFOLD_STATUS_HALF_FOLDED\b", content) and re.search(
                r"\b(?:LANDSCAPE|LANDSCAPE_INVERTED|orientation)\b", content):
            result.append(file)
        elif (re.search(r"\bfoldStatusChange\b", content) and
              re.search(r"\bFOLD_STATUS_HALF_FOLDED\b", content) and
              re.search(r"\b(?:height|width|position|visibility|translate|top|bottom|upper|lower)\b[\s\S]{0,240}\b(?:foldStatus|FOLD_STATUS_HALF_FOLDED)\b|\b(?:foldStatus|FOLD_STATUS_HALF_FOLDED)\b[\s\S]{0,240}\b(?:height|width|position|visibility|translate|top|bottom|upper|lower)\b", content)):
            result.append(file)
    return result


def _check_hover_fold_landscape(rule, evidence, _index):
    files = _hover_files(_ets_files(evidence))
    if not files:
        return base_result(rule, "不涉及", "未发现自定义悬停态 foldStatusChange，规则不涉及。")
    bad = [file for file in files if re.search(r"\bfoldStatusChange\b|\bFOLD_STATUS_HALF_FOLDED\b", file["content"])
           and (not re.search(r"\bFOLD_STATUS_HALF_FOLDED\b", file["content"]) or
                not re.search(r"\b(?:LANDSCAPE|LANDSCAPE_INVERTED|orientation)\b", file["content"]))]
    selected = bad or files
    return with_matches(base_result(rule, "不满足" if bad else "满足",
                                    "自定义悬停态未同时判断半折叠状态和横屏方向。" if bad else
                                    "自定义悬停态同时判断半折叠状态和横屏方向。"),
                        [{"file": file["relativePath"], "line": _line_of(file["content"], "foldStatus")}
                         for file in selected])


def _check_hover_crease(rule, evidence, _index):
    files = _hover_files(_ets_files(evidence))
    if not files:
        return base_result(rule, "不涉及", "未发现自定义悬停态，规则不涉及。")
    failed = [file for file in files if not re.search(r"getCurrentFoldCreaseRegion\s*\(", file["content"]) or
              not re.search(r"\bpx2vp\s*\(", file["content"])]
    selected = failed or files
    return with_matches(base_result(rule, "不满足" if failed else "满足",
                                    "自定义悬停态未通过 getCurrentFoldCreaseRegion 和 px2vp 获取折痕区域。" if failed else
                                    "自定义悬停态使用 getCurrentFoldCreaseRegion 和 px2vp 处理折痕区域。"),
                        [{"file": file["relativePath"],
                          "line": _line_of(file["content"], "foldStatus" if failed else "getCurrentFoldCreaseRegion")}
                         for file in selected])


def _check_hover_cleanup(rule, evidence, _index):
    files = [file for file in _hover_files(_ets_files(evidence)) if re.search(
        r'''display\.on\s*\(\s*['"]foldStatusChange['"]''', file["content"])]
    if not files:
        return base_result(rule, "不涉及", "未发现自定义悬停态 foldStatusChange 监听注册，规则不涉及。")
    failed = [file for file in files if not re.search(
        r'''aboutToDisappear\s*\([^)]*\)\s*(?::\s*[A-Za-z_][A-Za-z0-9_<>,\s.\[\]]*)?\s*\{[\s\S]{0,500}display\.off\s*\(\s*['"]foldStatusChange['"]''',
        file["content"])]
    selected = failed or files
    return with_matches(base_result(rule, "不满足" if failed else "满足",
                                    "foldStatusChange 监听未在 aboutToDisappear 中取消。" if failed else
                                    "foldStatusChange 监听在 aboutToDisappear 中取消。"),
                        [{"file": file["relativePath"], "line": _line_of(file["content"], "foldStatusChange")}
                         for file in selected])


def _check_web_size(rule, _evidence, index):
    instances = [item for item in index["componentInstances"] if item["component"] == "Web"]
    if not instances:
        return base_result(rule, "不涉及", "未发现 Web 组件，规则不涉及。")
    def fixed(value):
        return bool(re.fullmatch(r'''\s*(?:[0-9]+(?:\.[0-9]+)?|['"][0-9]+(?:\.[0-9]+)?(?:vp|px)?['"])\s*''', value))
    def responsive(value):
        return bool(responsive_expression(value) or re.search(r"\?|getValue|currentBreakpoint|WidthBreakpoint", value, re.I))
    failed = [item for item in instances if any(
        value and not responsive(value["valueText"]) and fixed(value["valueText"])
        for value in (property_value(item, "width"), property_value(item, "height")))]
    if failed:
        return with_matches(base_result(rule, "不满足", "Web 组件容器存在固定宽高。"),
                            _instance_locations(failed),
                            [_instance_snippet(item, {"properties": ["width", "height"]}) for item in failed])
    return with_matches(base_result(rule, "满足", "Web 组件容器尺寸未发现固定宽高反模式。"),
                        _instance_locations(instances))


def _check_web_sync(rule, evidence, index):
    instances = [item for item in index["componentInstances"] if item["component"] == "Web"]
    if not instances:
        return base_result(rule, "不涉及", "未发现 Web 组件，规则不涉及。")
    files = _ets_files(evidence)
    bad = _matches(files,
        r"\b(?:foldStatusChange|orientation)\b[\s\S]{0,240}\b(?:runJavaScript|javaScriptProxy|breakpoint)\b")
    if bad:
        return with_matches(base_result(rule, "不满足", "Web 断点同步由 foldStatusChange 或方向 API 驱动。"),
                            bad, _snippets(bad))
    good = _matches(files,
        r"\b(?:windowSizeChange|mediaquery\.matchMediaSync)[\s\S]{0,400}\b(?:runJavaScript|javaScriptProxy)\b|\b(?:runJavaScript|javaScriptProxy)[\s\S]{0,400}\b(?:currentBreakpoint|breakpoint|WidthBreakpoint)\b")
    if not good:
        return with_matches(base_result(rule, "不满足", "Web 组件未发现 Native 断点同步逻辑。"),
                            _instance_locations(instances))
    return with_matches(base_result(rule, "满足", "Web 组件存在基于标准断点来源的同步逻辑。"), good[:10])


def _check_web_media_width(rule, evidence, _index):
    matches = _matches(_web_files(evidence), r"@media[^{]+(?:min|max)-width\s*:\s*(\d+)px")
    if not matches:
        return base_result(rule, "不涉及", "未发现 Web 侧 width 媒体查询，规则不涉及。")
    failed = []
    for item in matches:
        width = re.search(r"(\d+)px", item.get("snippet", ""))
        if width and width.group(1) not in ("320", "600", "840", "1440"):
            failed.append(item)
    if failed:
        return with_matches(base_result(rule, "不满足", "Web 侧媒体查询断点与系统断点不一致。"),
                            failed, _snippets(failed))
    return with_matches(base_result(rule, "满足", "Web 侧媒体查询断点使用系统推荐值。"), matches[:10])


def _check_web_vertical(rule, evidence, _index):
    files = _web_files(evidence)
    bad = _matches(files, r"@media[^{]+(?:orientation|height\s*/\s*width|min-height|max-height)")
    if bad:
        return with_matches(base_result(rule, "不满足", "Web 侧纵向断点使用 orientation 或高宽相关条件。"),
                            bad, _snippets(bad))
    good = _matches(files, r"@media[^{]+aspect-ratio")
    if good:
        return with_matches(base_result(rule, "满足", "Web 侧纵向断点使用 aspect-ratio。"), good[:10])
    return base_result(rule, "不涉及", "未发现 Web 侧纵向断点媒体查询，规则不涉及。")


def _check_dynamic_constraint(rule, evidence, index):
    matches = _matches(_ets_files(evidence),
        r"\.constraintSize\s*\(\s*\{[\s\S]{0,300}\b(?:width|maxWidth)\s*:[\s\S]{0,240}\b(?:breakpoint|currentBreakpoint|WidthBreakpoint|sm|md|lg|xl|\?)", re.I)
    if not matches:
        return base_result(rule, "不涉及", "未发现按断点动态设置 width/maxWidth 的 constraintSize，规则不涉及。")
    has_grid = any(item["component"] in ("GridRow", "GridCol") for item in index["componentInstances"])
    return with_matches(base_result(rule, "满足" if has_grid else "不满足",
                                    "发现动态 constraintSize，同时工程存在 GridRow/GridCol 栅格布局证据，未判定为替代栅格的居中反模式。"
                                    if has_grid else "发现使用动态 constraintSize 实现大屏居中宽度限制。"),
                        matches, _snippets(matches))


def _check_aspect_ratio(rule, _evidence, index):
    instances = [item for item in index["componentInstances"] if property_value(item, "aspectRatio")]
    if not instances:
        return base_result(rule, "不涉及", "未发现 aspectRatio 配置，规则不涉及。")
    failed = [item for item in instances if not responsive_expression(property_value(item, "aspectRatio")["valueText"]) and
              not re.search(r"\?|getValue|currentBreakpoint|WidthBreakpoint",
                            property_value(item, "aspectRatio")["valueText"], re.I)]
    if failed:
        return with_matches(base_result(rule, "不满足", "aspectRatio 未按断点动态设置。"),
                            [{"file": item["filePath"], "line": property_value(item, "aspectRatio")["line"]}
                             for item in failed],
                            ["aspectRatio=" + property_value(item, "aspectRatio")["valueText"] for item in failed])
    return with_matches(base_result(rule, "满足", "aspectRatio 均按断点动态设置。"),
                        [{"file": item["filePath"], "line": property_value(item, "aspectRatio")["line"]}
                         for item in instances])


CHECKS = {
    "module_device_types_multi_device": _check_device_types,
    "breakpoint_ranges_standard": _check_breakpoint_ranges,
    "breakpoint_no_hardcoded_width": _check_hardcoded_width,
    "breakpoint_source_standard": _check_breakpoint_source,
    "breakpoint_listener_source_standard": _check_listener_source,
    "breakpoint_listener_after_load_content": _check_listener_timing,
    "folderstack_fullscreen": _check_folder_fullscreen,
    "folderstack_upper_items_ids": _check_folder_upper_ids,
    "custom_hover_fold_and_landscape": _check_hover_fold_landscape,
    "custom_hover_crease_region_api": _check_hover_crease,
    "custom_hover_fold_listener_cleanup": _check_hover_cleanup,
    "web_container_size_by_breakpoint": _check_web_size,
    "web_breakpoint_sync_source": _check_web_sync,
    "web_media_query_breakpoints_standard": _check_web_media_width,
    "web_vertical_breakpoint_aspect_ratio": _check_web_vertical,
    "gridrow_no_dynamic_constraint_size_centering": _check_dynamic_constraint,
    "aspect_ratio_by_breakpoint": _check_aspect_ratio,
}


def evaluate_text_rule(rule, evidence, index):
    check = rule["detector"]["config"].get("check")
    function = CHECKS.get(check)
    return (function(rule, evidence, index) if function else
            base_result(rule, "未接入判定器", rule["summary"] + " 未注册静态检查项。",
                        {"check": check}))

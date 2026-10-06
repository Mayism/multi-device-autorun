"""Generic ArkUI component rule evaluation in Python."""

import re

from pyautorun.whitebox_eval.rules.arkui_specs import MANUAL_CHECKS, SPEC_BY_CHECK
from pyautorun.whitebox_eval.rules.arkui_values import (breakpoint_map, helper_numbers, non_decreasing,
                                    object_property, opaque_responsive, property_value,
                                    resolve_constants, responsive_expression, varying_boolean)


def base_result(rule, status, conclusion, preliminary=None):
    return {"rule_id": rule["rule_id"], "rule_source": rule["rule_source"],
            "result": status, "conclusion": conclusion, "matchedFiles": [],
            "preliminaryData": preliminary or {}}


def with_matches(result, matches, snippets=None):
    locations = [f'{item["file"]}:{item["line"]}' for item in matches]
    conclusion = result["conclusion"]
    if result["result"] == "不满足" and locations and not re.search(r"(?:位置|文件)：", conclusion):
        conclusion += " 位置：" + ", ".join(dict.fromkeys(locations))
    return {**result, "conclusion": conclusion,
            "matchedFiles": list(dict.fromkeys(item["file"] for item in matches)),
            "matchedLocations": locations,
            "matchedSnippets": snippets if snippets is not None else
            [item["snippet"] for item in matches if item.get("snippet")]}


def _loc(instance):
    return {"file": instance["filePath"], "line": instance["line"]}


def _value(instance, name):
    return property_value(instance, name)


def _ancestors(index, target, component):
    return [item for item in index["componentInstances"]
            if item["filePath"] == target["filePath"] and item["component"] == component
            and item["startIndex"] < target["startIndex"] and item["endIndex"] > target["endIndex"]]


def _responsive_gridrow_ancestor(index, target):
    for item in _ancestors(index, target, "GridRow"):
        columns = resolve_constants((_value(item, "columns") or {}).get("valueText", ""), index)
        if columns and (non_decreasing(columns) or responsive_expression(columns) or breakpoint_map(columns)):
            return True
    return False


def _opaque_gridrow_ancestor(index, target):
    return any(opaque_responsive((_value(item, "columns") or {}).get("valueText", ""), index)
               for item in _ancestors(index, target, "GridRow") if _value(item, "columns"))


def _sm_list_alternate_grid(instance, index):
    condition = instance.get("breakpointCondition", "")
    sm_branch = re.search(r'''\b(?:curBp|currentBreakpoint|breakpoint)\b[^;\n{}]*(?<!!)={2,3}\s*['"]sm['"]|['"]sm['"]\s*(?<!!)={2,3}\s*\b(?:curBp|currentBreakpoint|breakpoint)\b''',
                          condition, re.I)
    return bool(sm_branch and any(item["filePath"] == instance["filePath"] and
                                  item["component"] == "GridRow" and
                                  item["startIndex"] > instance["endIndex"]
                                  for item in index["componentInstances"]))


def _dynamic_columns(value, index):
    resolved = resolve_constants(value, index)
    if "?" in resolved and ":" in resolved:
        return False
    if breakpoint_map(resolved) or len(helper_numbers(resolved, index)) >= 2:
        return True
    templates = [match.group(1) for match in re.finditer(r'''["']([^"']*fr[^"']*)["']''', resolved)]
    return len(set(templates)) >= 2 and responsive_expression(resolved)


def _page_tabs(instance, spec, index):
    if any(responsive_expression((_value(instance, name) or {}).get("valueText", ""))
           for name in spec["properties"]):
        return True
    descendants = [item for item in index["componentInstances"]
                   if item["filePath"] == instance["filePath"] and
                   item["startIndex"] > instance["startIndex"] and
                   item["endIndex"] < instance["endIndex"]]
    if sum(item["component"] == "TabContent" for item in descendants) < 2:
        return False
    components = {item["component"] for item in descendants}
    if ("List" in components or "ListItem" in components) and not {"NavDestination", "Navigation"} & components:
        return False
    return any(re.search(r"(?:NavDestination|Navigation|Page|Content|Root|Entry)", item["component"])
               for item in descendants)


def _applicable(instance, spec, index):
    check = spec["check"]
    if check in ("tabs_vertical_by_breakpoint", "tabs_bar_position_by_breakpoint", "tabs_bar_size_by_breakpoint"):
        return _page_tabs(instance, spec, index)
    if check in ("swiper_indicator_by_display_count", "swiper_margins_for_multi_display"):
        display = _value(instance, "displayCount")
        if not display:
            return False
        try:
            fixed_one = float(resolve_constants(display["valueText"]).strip()) == 1
        except ValueError:
            fixed_one = False
        return not fixed_one
    if check == "list_divider_by_lanes":
        return bool(_value(instance, "lanes") and _value(instance, "divider"))
    if check == "list_space_by_breakpoint":
        if not _value(instance, "space"):
            return False
        if instance.get("breakpointContext"):
            return True
        lanes = (_value(instance, "lanes") or {}).get("valueText")
        if not lanes:
            return False
        resolved = resolve_constants(lanes, index)
        return bool(breakpoint_map(resolved) or len(helper_numbers(resolved, index)) >= 2 or
                    responsive_expression(resolved) or opaque_responsive(resolved, index))
    if check == "gridrow_gutter_required":
        return sum(item["filePath"] == instance["filePath"] and item["component"] == "GridCol" and
                   item["startIndex"] > instance["startIndex"] and item["endIndex"] < instance["endIndex"]
                   for item in index["componentInstances"]) >= 2
    if check == "waterflow_sliding_window_mode":
        columns = (_value(instance, "columnsTemplate") or {}).get("valueText")
        return bool(columns and (_dynamic_columns(columns, index) or opaque_responsive(columns, index)))
    if not spec["properties"] or not spec.get("ignoreMissingProperties"):
        return True
    return any(_value(instance, name) for name in spec["properties"])


def _satisfied(instance, spec, index):
    check = spec["check"]
    values = [_value(instance, name) for name in spec["properties"]]
    if not values:
        return True
    requirement = spec["requirement"]
    if requirement == "exists":
        return all(values) if spec.get("allPropertiesRequired") else any(values)
    if requirement == "breakpoint_aware" and check == "gridcol_span_by_breakpoint" and _responsive_gridrow_ancestor(index, instance):
        return True
    if check == "swiper_indicator_by_display_count":
        return any(value and (value["valueText"].strip() == "false" or value["usesBreakpoint"] or
                              responsive_expression(value["valueText"])) for value in values)
    if check == "swiper_margins_for_multi_display":
        return any(values)
    if check == "waterflow_sliding_window_mode":
        columns = (_value(instance, "columnsTemplate") or {}).get("valueText", "")
        if not _dynamic_columns(columns, index):
            return True
    if spec.get("allPropertiesRequired") and not all(values):
        return False
    present = [value for value in values if value]
    if not present:
        return False
    if requirement == "breakpoint_aware":
        if check == "list_space_by_breakpoint" and _sm_list_alternate_grid(instance, index):
            return True
        if check == "sidebar_show_by_breakpoint":
            return all(varying_boolean(value["valueText"], index) for value in present)
        return all(value["usesBreakpoint"] or responsive_expression(value["valueText"]) or
                   breakpoint_map(value["valueText"]) for value in present)
    if requirement == "non_decreasing":
        return all(non_decreasing(resolve_constants(value["valueText"], index), index) for value in present)
    if requirement == "contains":
        return any(spec.get("expectedText") in value["valueText"] if spec.get("expectedText") else True
                   for value in present)
    if requirement == "contains_all":
        return any(all(text in resolve_constants(value["valueText"], index)
                       for text in spec.get("expectedTexts", [])) for value in present)
    return False


def _defer(instance, spec, index):
    check = spec["check"]
    if spec["requirement"] == "breakpoint_aware" and check == "gridcol_span_by_breakpoint" and _opaque_gridrow_ancestor(index, instance):
        return True
    if spec["requirement"] not in ("breakpoint_aware", "non_decreasing", "contains_all"):
        return check == "waterflow_sliding_window_mode" and opaque_responsive(
            (_value(instance, "columnsTemplate") or {}).get("valueText", ""), index)
    if check in ("list_space_by_breakpoint", "gridrow_columns_non_decreasing") and instance.get("breakpointContext"):
        return True
    if check == "sidebar_show_by_breakpoint":
        return any(not varying_boolean(value["valueText"], index)
                   for value in (_value(instance, name) for name in spec["properties"]) if value)
    if check == "swiper_margins_for_multi_display" and (_value(instance, "disableSwipe") or {}).get("valueText", "").strip() == "true":
        return True
    return any(opaque_responsive(value["valueText"], index)
               for value in (_value(instance, name) for name in spec["properties"]) if value)


def _preliminary(spec, instances):
    inspected = []
    for instance in instances:
        entry = {"filePath": instance["filePath"], "line": instance["line"],
                 "properties": [{"name": item["name"], "line": item["line"],
                                 "usesBreakpoint": item["usesBreakpoint"]} for item in instance["properties"]],
                 "checkedProperties": [_value(instance, name) for name in spec["properties"]
                                       if _value(instance, name)]}
        if "breakpointContext" in instance:
            entry["breakpointContext"] = instance["breakpointContext"]
        inspected.append(entry)
    return {"check": spec["check"], "component": spec["component"],
            "properties": spec["properties"], "requirement": spec["requirement"],
            "inspectedComponentCount": len(instances), "inspectedComponents": inspected}


def _instance_snippet(instance, spec):
    props = " ".join(name + "=" + ((_value(instance, name) or {}).get("valueText") or "<missing>")
                     for name in spec["properties"])
    return instance["component"] + "(" + instance["argumentText"] + ") " + props


def _property_snippet(instance, spec):
    return "; ".join(value["name"] + "=" + value["valueText"]
                     for value in (_value(instance, name) for name in spec["properties"]) if value)


def _structure_attrs(instance):
    argument = instance["argumentText"].strip()
    if not argument.startswith("{"):
        constructor = [{"name": "constructor", "valueText": argument}] if argument else []
    else:
        constructor = [{"name": match.group(1),
                        "valueText": object_property(argument, match.group(1)) or "<unknown>"}
                       for match in re.finditer(r"\b([A-Za-z_$][\w$]*)\s*:", argument)]
    return constructor + [{"name": item["name"], "valueText": item["argumentText"]}
                          for item in instance["properties"]]


def _source_snippet(instance, evidence):
    all_files = evidence.get("allWorkspaceFiles")
    file = next((item for item in (evidence["workspaceFiles"] if all_files is None else all_files)
                 if item["relativePath"] == instance["filePath"]), None)
    if not file:
        return instance["component"] + "(" + instance["argumentText"] + ")"
    lines = re.split(r"\r?\n", file["content"])
    start = max(1, instance["line"] - 1)
    end = min(len(lines), instance["line"] + 8)
    return "\n".join(lines[start - 1:end]).strip()


def _manual_snippet(instance, spec, evidence):
    if instance.get("source") != "arkFacts":
        return _source_snippet(instance, evidence)
    attrs = "; ".join(item["name"] + "=" + item["valueText"] for item in _structure_attrs(instance))
    return (instance["component"] + " parent=" + (instance.get("parentComponent") or "<none>") +
            " children=" + (",".join(instance.get("childComponents", [])) or "<none>") +
            " props=" + (attrs or _property_snippet(instance, spec) or "<none>"))


def _requirement(spec):
    if spec["check"] == "swiper_margins_for_multi_display":
        return "多元素展示时至少配置 prevMargin 或 nextMargin 一侧边距"
    return {"breakpoint_aware": "按断点动态设置", "non_decreasing": "断点数值非递减",
            "exists": "显式配置", "contains_all": "包含 " + "/".join(spec.get("expectedTexts", []))}.get(
                spec["requirement"], "包含 " + spec.get("expectedText", "指定值"))


def evaluate_component_rule(rule, evidence, index):
    check = rule["detector"]["config"].get("check")
    spec = SPEC_BY_CHECK.get(check)
    if not spec:
        return base_result(rule, "未接入判定器", rule["summary"] + " 未注册 ArkUI 静态检查项。",
                           {"check": check} if check is not None else {})
    paths = {file["relativePath"] for file in evidence["workspaceFiles"]}
    instances = [item for item in index["componentInstances"]
                 if item["filePath"] in paths and item["component"] == spec["component"]]
    if check in MANUAL_CHECKS:
        if not instances:
            return base_result(rule, "不涉及", f'未发现 {spec["component"]} 组件，规则不涉及。',
                               {"check": check, "component": spec["component"], "inspectedComponentCount": 0})
        review = instances[:5]
        review_evidence = []
        for instance in review:
            item = {"rule_id": check, "file": instance["filePath"], "line": instance["line"],
                    "subject": instance["component"],
                    "question": f'请结合源码片段中的 {instance["component"]} 子组件职责判断该规则是否适用，以及是否满足一多适配要求。'}
            if instance.get("source") == "arkFacts":
                structure = {"children": instance.get("childComponents", []),
                             "attributes": _structure_attrs(instance)}
                if instance.get("componentId"):
                    structure["componentId"] = instance["componentId"]
                if instance.get("parentComponent"):
                    structure["parent"] = instance["parentComponent"]
                item["structure"] = structure
            else:
                item["source"] = _source_snippet(instance, evidence)
            review_evidence.append(item)
        return with_matches(base_result(rule, "未接入判定器",
                                        f'{spec["component"]} {"/".join(spec["properties"])} 的适用场景依赖布局意图，当前静态扫描提供组件源码片段，需要 Agent 复核。',
                                        {"check": check, "component": spec["component"],
                                         "properties": spec["properties"], "requirement": spec["requirement"],
                                         "inspectedComponentCount": len(instances), "reviewEvidence": review_evidence}),
                            [_loc(item) for item in review],
                            [_manual_snippet(item, spec, evidence) for item in review])
    if not instances:
        return base_result(rule, "不涉及", f'未发现 {spec["component"]} 组件，规则不涉及。',
                           {"check": check, "component": spec["component"], "inspectedComponentCount": 0})
    applicable = [item for item in instances if _applicable(item, spec, index)]
    if not applicable:
        return base_result(rule, "不涉及",
                           f'{spec["component"]} 未发现需要检查的 {"/".join(spec["properties"])} 配置，规则不涉及。',
                           {**_preliminary(spec, instances), "applicableComponentCount": 0})
    review = [item for item in applicable if _defer(item, spec, index)]
    failed = [item for item in applicable if item not in review and not _satisfied(item, spec, index)]
    if failed:
        return with_matches(base_result(rule, "不满足",
                                        f'{spec["component"]} {"/".join(spec["properties"])} 未满足 {_requirement(spec)}。',
                                        _preliminary(spec, applicable)),
                            [_loc(item) for item in failed], [_instance_snippet(item, spec) for item in failed])
    if review:
        evidence_items = [{"rule_id": check, "file": item["filePath"], "line": item["line"],
                           "subject": item["component"], "evidence": _property_snippet(item, spec),
                           "question": f'请结合规则描述和源码上下文复核该 {item["component"]} 是否满足一多适配要求。'}
                          for item in review]
        return with_matches(base_result(rule, "未接入判定器",
                                        f'{spec["component"]} {"/".join(spec["properties"])} 使用静态层无法稳定解释的封装表达式，需要 Agent 复核。',
                                        {**_preliminary(spec, review), "reviewEvidence": evidence_items}),
                            [_loc(item) for item in review], [_property_snippet(item, spec) for item in review])
    result = base_result(rule, "满足", f'{spec["component"]} {"/".join(spec["properties"])} 均满足 {_requirement(spec)}。',
                         _preliminary(spec, applicable))
    return {**result, "matchedFiles": list(dict.fromkeys(item["filePath"] for item in applicable)),
            "matchedLocations": [f'{item["filePath"]}:{item["line"]}' for item in applicable]}

"""Convert retained ArkAnalyzer component facts to ArkUI rule scan input."""

import json
import re


OPAQUE = {"GridRow": ["breakpoints", "columns"], "GridCol": ["span", "offset"],
          "SideBarContainer": ["type"], "FolderStack": ["upperItems"]}
CREATE_PROPERTY = {"SideBarContainer": "type", "FolderStack": "upperItems"}


def _render(expr):
    if not expr:
        return ""
    kind = expr.get("kind")
    if kind == "literal":
        value = expr.get("value")
        if isinstance(value, str):
            return value + str(expr.get("unit") or "") if expr.get("unit") else json.dumps(value, ensure_ascii=False)
        return ("true" if value is True else "false" if value is False else "null" if value is None else str(value)) + str(expr.get("unit") or "")
    if kind in ("enum", "symbol"):
        return expr["name"]
    if kind == "resource":
        return "$r('" + expr["name"] + "')"
    if kind == "array":
        return "[" + ", ".join(_render(item) for item in expr.get("items", [])) + "]"
    if kind in ("object", "breakpointValue"):
        values = expr.get("properties" if kind == "object" else "values", {})
        return "{ " + ", ".join(f"{key}: {_render(value)}" for key, value in values.items()) + " }"
    if kind == "call":
        return expr["callee"] + "(" + ", ".join(_render(item) for item in expr.get("args", [])) + ")"
    return expr.get("raw") or ""


def _attribute_value(attribute):
    expr = attribute.get("expr")
    if expr and expr.get("kind") == "opaque":
        return "__arkAnalyzerOpaque(" + attribute["name"] + ")"
    return _render(expr) if expr else "__arkAnalyzerOpaque(" + attribute["name"] + ")"


def _uses_breakpoint(expr):
    if not expr:
        return False
    kind = expr.get("kind")
    if kind == "breakpointValue":
        return True
    if kind == "symbol":
        return bool(re.search(r"breakpoint|isLargeScreen|isMediumScreen|isSmallScreen", expr.get("name", ""), re.I))
    if kind == "object":
        return any(key in ("sm", "md", "lg", "xl") for key in expr.get("properties", {}))
    return False


def _constructor_attributes(component):
    attributes = component.get("attributes", [])
    props = [item for item in attributes if item.get("source") == "constructor"]
    create = next((item for item in attributes if item.get("source") == "create"), None)
    create_name = CREATE_PROPERTY.get(component["name"])
    if create_name and create and create.get("expr") and create["expr"].get("kind") != "opaque":
        props.append({"name": create_name, "source": "constructor", "line": create.get("line"),
                      "expr": create["expr"]})
    if create and (create.get("expr") or {}).get("kind") == "opaque":
        present = {item["name"] for item in props}
        for name in OPAQUE.get(component["name"], []):
            if name not in present:
                props.append({"name": name, "source": "constructor", "line": create.get("line"),
                              "expr": {"kind": "opaque", "reason": "unresolved " + component["name"] + ".create argument",
                                       "raw": name}})
    return props


def index_from_ark_facts(facts):
    components = facts.get("components", [])
    by_id = {item["id"]: item for item in components}
    instances = []
    counts = {}
    for index, component in enumerate(components):
        constructor = _constructor_attributes(component)
        argument = ("{ " + ", ".join(item["name"] + ": " + _attribute_value(item)
                                      for item in constructor) + " }") if constructor else ""
        parent = by_id.get(component.get("parentId"))
        children = component.get("childIds") or []
        instance = {"componentId": component["id"], "component": component["name"],
                    "filePath": component["filePath"], "line": component.get("line") or 1,
                    "startIndex": index, "endIndex": index, "argumentText": argument,
                    **({"parentId": component["parentId"]} if component.get("parentId") else {}),
                    **({"parentComponent": parent["name"]} if parent else {}),
                    "childIds": children,
                    "childComponents": [by_id[child]["name"] for child in children if child in by_id],
                    "source": "arkFacts",
                    "properties": [{"name": item["name"], "argumentText": _attribute_value(item),
                                    "line": item.get("line") or component.get("line") or 1,
                                    "usesBreakpoint": _uses_breakpoint(item.get("expr")) or
                                                      bool(component.get("stateRefs"))}
                                   for item in component.get("attributes", [])
                                   if item.get("source") not in ("constructor", "create")]}
        instances.append(instance)
        path = component["filePath"]
        counts[path] = counts.get(path, 0) + 1
    return {"componentInstances": instances, "constants": {},
            "files": [{"relativePath": path, "componentCount": count} for path, count in counts.items()]}

"""Deterministic ArkTS static rules backed by source or ArkAnalyzer facts."""

import re

from .whitebox_arkts_scanner import scan_arkts_light_facts


def _violation(rule, matches):
    locations = [f'{item["relativePath"]}:{item["line"]}' for item in matches]
    files = list(dict.fromkeys(item["relativePath"] for item in matches))
    return {"rule_id": rule["rule_id"], "rule_source": rule["rule_source"],
            "result": "不满足" if matches else "满足",
            "conclusion": (f'{rule["summary"]} 检测到规则命中，位置：{", ".join(locations)}'
                           if matches else "未发现该规则的命中证据。"),
            "matchedFiles": files, "matchedLocations": locations,
            "matchedSnippets": [f'{item["relativePath"]}:{item["line"]}: {item["text"]}'
                                for item in matches]}


def _simple(items):
    return [{"relativePath": item["relativePath"], "line": item["line"], "text": item["text"]}
            for item in items]


def _enum_kind(value):
    if not value:
        return "none"
    if re.fullmatch(r"-?\d+(?:\.\d+)?", value):
        return "number"
    if re.fullmatch(r'''["'][^"']*["']''', value):
        return "string"
    return "runtime"


def evaluate_arkts_static_rule(rule, evidence, index=None):
    config = rule["detector"]["config"]
    if index is None:
        # The ArkAnalyzer adapter is supplied by the optional sidecar when enabled.
        if (evidence.get("arkFacts") or {}).get("declarations"):
            from .whitebox_arkts_ast import index_from_ark_facts
            index = index_from_ark_facts(evidence["arkFacts"],
                                         {file["relativePath"] for file in evidence["workspaceFiles"]})
        else:
            index = scan_arkts_light_facts(evidence, config.get("fileExtensions") or [".ets"])
    files = index["files"]
    named = [item for file in files for item in file["namedDeclarations"]]
    check = config.get("check")
    if check == "class_property_access_modifier":
        matches = [item for file in files for item in file["classProperties"] if not item["hasAccessModifier"]]
    elif check == "object_literal_class_initialization":
        matches = [item for file in files for item in file["objectLiteralClassInitializations"]
                   if item["className"] in index["classNames"]]
    elif check == "let_never_reassigned":
        matches = [item for file in files for item in file["variableDeclarations"]
                   if item["kind"] == "let" and not re.search(r"[,[\]{}]", item["name"])
                   and not any(assignment["name"] == item["name"] and assignment["line"] > item["line"]
                               for assignment in file["assignments"])]
    elif check == "identifier_name_conflict":
        type_like = [item for item in named if item["kind"] in
                     ("class", "interface", "type", "enum", "namespace")]
        counts = {}
        for item in type_like:
            counts[item["name"]] = counts.get(item["name"], 0) + 1
        matches = [item for item in type_like if item["name"] in index["valueNames"] or
                   counts[item["name"]] > 1]
    elif check == "class_interface_heritage":
        matches = [item for file in files for item in file["heritage"]
                   if (any(name in index["classNames"] for name in item["implementsNames"]) or
                       any(name in index["interfaceNames"] for name in item["extendsNames"]))
                   if item["kind"] == "class"]
        matches += [item for file in files for item in file["heritage"]
                    if item["kind"] != "class" and
                    any(name in index["classNames"] for name in item["extendsNames"])]
        # Preserve file order when both class and interface heritage are present.
        ids = {id(item) for item in matches}
        matches = [item for file in files for item in file["heritage"] if id(item) in ids]
    elif check == "esobject_usage_scope":
        matches = [item for item in named if item.get("typeName") == "ESObject" or
                   re.search(r"\bESObject\b", item["text"])]
    elif check == "class_as_value":
        matches = [item for item in named if item["kind"] == "variable" and item.get("initializer")
                   and re.sub(r";$", "", item["initializer"]).strip() in index["classNames"]]
    elif check == "type_name_upper_camel":
        matches = [item for item in named if item["kind"] in ("class", "interface", "enum", "namespace")
                   and not re.fullmatch(r"[A-Z][A-Za-z0-9]*", item["name"])]
    elif check == "value_name_lower_camel":
        matches = [item for item in named if item["kind"] in ("variable", "function", "method", "parameter")
                   and not re.fullmatch(r"[a-z][A-Za-z0-9]*", item["name"])]
    elif check == "constant_enum_upper_snake":
        matches = [item for item in named if item["kind"] == "enumMember" and
                   not re.fullmatch(r"[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*", item["name"])]
        matches += [item for file in files for item in file["variableDeclarations"]
                    if item["kind"] == "const" and item["scope"] == "topLevel" and
                    not re.fullmatch(r"[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*", item["name"])]
    elif check == "boolean_name_prefix":
        matches = [item for item in named if item.get("typeName") == "boolean" and
                   (not re.search(r"^(?:is|has|can|should)[A-Z]", item["name"]) or
                    re.search(r"^(?:not|no|non|disable|disabled|invalid)[A-Z_]", item["name"], re.I))]
    elif check == "spacing_style":
        matches = [item for file in files for item in file["spacingIssues"]]
    elif check == "enum_namespace_restrictions":
        matches = []
        for file in files:
            for item in file["enums"]:
                kinds = {_enum_kind(member.get("initializer")) for member in item["memberInitializers"]}
                if "runtime" in kinds or {"number", "string"} <= kinds or item["name"] in index["namespaceNames"]:
                    matches.append(item)
    else:
        return {"rule_id": rule["rule_id"], "rule_source": rule["rule_source"],
                "result": "未接入判定器",
                "conclusion": rule["summary"] + " 当前版本未接入静态判定器，需要 Agent 辅助判定。",
                "matchedFiles": []}
    return _violation(rule, _simple(matches))

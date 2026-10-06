"""Map retained ArkAnalyzer facts to the ArkTS rule scan index."""

import json


def _render(expr):
    if not expr:
        return None
    kind = expr.get("kind")
    if kind == "literal":
        value = expr.get("value")
        return json.dumps(value, ensure_ascii=False, separators=(",", ":")) if isinstance(value, str) else str(value).lower() if isinstance(value, bool) else str(value) if value is not None else "null"
    if kind in ("enum", "resource", "symbol"):
        return expr.get("name")
    if kind == "array":
        return "[" + ", ".join(_render(item) or "" for item in expr.get("items", [])) + "]"
    if kind in ("object", "breakpointValue"):
        properties = expr.get("properties" if kind == "object" else "values", {})
        return "{ " + ", ".join(f"{key}: {_render(value) or ''}" for key, value in properties.items()) + " }"
    if kind == "call":
        return str(expr.get("callee", "")) + "(" + ", ".join(_render(item) or "" for item in expr.get("args", [])) + ")"
    return expr.get("raw")


def _empty(path):
    return {"relativePath": path, "classes": [], "interfaces": [], "typeAliases": [],
            "enums": [], "namespaces": [], "namedDeclarations": [], "heritage": [],
            "classProperties": [], "variableDeclarations": [], "assignments": [],
            "objectLiteralClassInitializations": [], "spacingIssues": []}


def _optional(key, value):
    return {key: value} if value is not None else {}


def index_from_ark_facts(facts, included_paths=None):
    files = {}
    def allowed(path):
        return included_paths is None or path in included_paths
    def get(path):
        return files.setdefault(path, _empty(path))
    for source in facts.get("files", []):
        path = source["relativePath"]
        if allowed(path):
            get(path)
    for declaration in facts.get("declarations", []):
        path = declaration["filePath"]
        if not allowed(path):
            continue
        file = get(path)
        line = declaration.get("line") or 1
        kind = declaration["kind"]
        name = declaration["name"]
        if kind in ("class", "struct"):
            file["classes"].append({"name": name, "line": line})
            file["heritage"].append({"relativePath": path, "line": line, "kind": "class",
                                     "name": name, "extendsNames": declaration.get("extendsNames", []),
                                     "implementsNames": declaration.get("implementsNames", []),
                                     "text": f"class {name}"})
        elif kind == "interface":
            file["interfaces"].append({"name": name, "line": line})
            file["heritage"].append({"relativePath": path, "line": line, "kind": "interface",
                                     "name": name, "extendsNames": declaration.get("extendsNames", []),
                                     "implementsNames": [], "text": f"interface {name}"})
        elif kind == "enum":
            members = declaration.get("enumMembers") or []
            file["enums"].append({"relativePath": path, "line": line, "name": name,
                                  "memberInitializers": [{"name": member["name"],
                                                          **_optional("initializer", _render(member.get("initializer")))}
                                                         for member in members],
                                  "text": f"enum {name}"})
            for member in members:
                file["namedDeclarations"].append({"relativePath": path, "line": member.get("line") or line,
                                                  "kind": "enumMember", "name": member["name"],
                                                  **_optional("initializer", _render(member.get("initializer"))),
                                                  "text": member["name"]})
        elif kind == "namespace":
            file["namespaces"].append({"name": name, "line": line})
        file["namedDeclarations"].append({"relativePath": path, "line": line,
                                          "kind": "class" if kind == "struct" else kind,
                                          "name": name, "text": f"{kind} {name}"})
        for field in declaration.get("fields") or []:
            field_line = field.get("line") or line
            file["classProperties"].append({"relativePath": path, "line": field_line,
                                            "name": field["name"], "text": field["name"],
                                            "hasAccessModifier": bool(field.get("accessModifier"))})
            file["namedDeclarations"].append({"relativePath": path, "line": field_line,
                                              "kind": "classProperty", "name": field["name"],
                                              **_optional("typeName", field.get("typeText")),
                                              **_optional("initializer", _render(field.get("initializer"))),
                                              "text": field["name"]})
    for method in facts.get("methods", []):
        path = method["filePath"]
        if not allowed(path):
            continue
        file = get(path)
        line = method.get("line") or 1
        file["namedDeclarations"].append({"relativePath": path, "line": line, "kind": "method",
                                          "name": method["name"], "text": "method " + method["name"]})
        for parameter in method.get("parameters") or []:
            type_name = parameter.get("typeText")
            file["namedDeclarations"].append({"relativePath": path, "line": line, "kind": "parameter",
                                              "name": parameter["name"], **_optional("typeName", type_name),
                                              "text": parameter["name"] + (": " + type_name if type_name else "")})
        for assignment in method.get("assignments") or []:
            rendered = _render(assignment.get("value"))
            file["assignments"].append({"relativePath": path, "line": assignment.get("line") or line,
                                        "name": assignment["target"],
                                        "text": assignment["target"] + " = " + (rendered or "undefined")})
    result_files = list(files.values())
    names = lambda key: {item["name"] for file in result_files for item in file[key]}
    class_names = names("classes")
    interface_names = names("interfaces")
    namespace_names = names("namespaces")
    return {"files": result_files, "classNames": class_names, "interfaceNames": interface_names,
            "typeLikeNames": class_names | interface_names | namespace_names | names("enums") | names("typeAliases"),
            "namespaceNames": namespace_names,
            "valueNames": {item["name"] for file in result_files for item in file["namedDeclarations"]
                           if item["kind"] in ("function", "method", "variable")}}

"""Lightweight ArkTS source facts used by deterministic rule checks."""

from pathlib import Path
import re


IDENTIFIER = r"[A-Za-z_$][\w$]*"


def _match(pattern, text):
    return re.search(pattern, text, re.ASCII)


def _type_names(value):
    return [match.group() for part in (value or "").split(",")
            if (match := _match(IDENTIFIER, part.strip()))]


def _parameters(value):
    result = []
    for part in value.split(","):
        match = _match(r"^(?:public|private|protected|readonly\s+)*(" + IDENTIFIER +
                       r")\??\s*(?::\s*(" + IDENTIFIER + r"))?", part.strip())
        if match:
            result.append({"name": match.group(1), **({"typeName": match.group(2)} if match.group(2) else {})})
    return result


def _enum_members(value):
    result = []
    for part in value.split(","):
        match = _match(r"^(" + IDENTIFIER + r")(?:\s*=\s*(.+))?$", part.strip())
        if match:
            result.append({"name": match.group(1), **({"initializer": match.group(2).strip()}
                                                      if match.group(2) else {})})
    return result


def _scan_file(file):
    relative = file["relativePath"]
    facts = {"relativePath": relative, "classes": [], "interfaces": [], "typeAliases": [],
             "enums": [], "namespaces": [], "namedDeclarations": [], "heritage": [],
             "classProperties": [], "variableDeclarations": [], "assignments": [],
             "objectLiteralClassInitializations": [], "spacingIssues": []}
    patch = set(file["patchLineNumbers"]) if file.get("patchLineNumbers") is not None else None
    def in_patch(line):
        return patch is None or line in patch

    def item(kind, name, line, raw, **extra):
        return {"relativePath": relative, "line": line, "kind": kind, "name": name,
                **extra, "text": raw.strip()}

    def parameters(value, line, raw):
        if in_patch(line):
            facts["namedDeclarations"].extend(item("parameter", parameter["name"], line, raw,
                                                    **({"typeName": parameter["typeName"]}
                                                       if "typeName" in parameter else {}))
                                               for parameter in _parameters(value))

    class_stack = []
    current_enum = None
    depth = 0
    for line, raw in enumerate(re.split(r"\r?\n", file["content"]), 1):
        without_comment = re.sub(r"//.*$", "", raw)
        text = without_comment.strip()
        if in_patch(line) and text and (re.search(r"\s+$", without_comment) or
                                        re.search(r"\S {2,}\S", text)):
            facts["spacingIssues"].append({"relativePath": relative, "line": line, "text": raw.strip()})
        class_match = _match(r"\bclass\s+(" + IDENTIFIER + r")(?:\s+extends\s+(" + IDENTIFIER +
                             r"))?(?:\s+implements\s+([^{]+))?", text)
        if class_match:
            name = class_match.group(1)
            facts["classes"].append({"name": name, "line": line})
            if in_patch(line):
                facts["namedDeclarations"].append(item("class", name, line, raw))
                facts["heritage"].append({"relativePath": relative, "line": line, "kind": "class",
                                          "name": name, "extendsNames": _type_names(class_match.group(2)),
                                          "implementsNames": _type_names(class_match.group(3)),
                                          "text": raw.strip()})
            class_stack.append((name, depth + 1))
        interface_match = _match(r"\binterface\s+(" + IDENTIFIER + r")(?:\s+extends\s+([^{]+))?", text)
        if interface_match:
            name = interface_match.group(1)
            facts["interfaces"].append({"name": name, "line": line})
            if in_patch(line):
                facts["namedDeclarations"].append(item("interface", name, line, raw))
                facts["heritage"].append({"relativePath": relative, "line": line, "kind": "interface",
                                          "name": name, "extendsNames": _type_names(interface_match.group(2)),
                                          "implementsNames": [], "text": raw.strip()})
        type_match = _match(r"\btype\s+(" + IDENTIFIER + r")\b", text)
        if type_match:
            name = type_match.group(1)
            facts["typeAliases"].append({"name": name, "line": line})
            if in_patch(line):
                facts["namedDeclarations"].append(item("type", name, line, raw))
        if current_enum is not None and not _match(r"\benum\s+(" + IDENTIFIER + r")\b", text):
            member_text = re.sub(r"\}.*$", "", text).rstrip(",").strip()
            members = _enum_members(member_text)
            current_enum["memberInitializers"].extend(members)
            if in_patch(line):
                facts["namedDeclarations"].extend(item("enumMember", member["name"], line, raw,
                                                        **({"initializer": member["initializer"]}
                                                           if "initializer" in member else {}))
                                                   for member in members)
            if "}" in text:
                current_enum = None
        enum_match = _match(r"\benum\s+(" + IDENTIFIER + r")\b(?:[^{]*\{(.*)\})?", text)
        if enum_match:
            name = enum_match.group(1)
            members = _enum_members(enum_match.group(2) or "")
            enum_fact = {"relativePath": relative, "line": line, "name": name,
                         "memberInitializers": members, "text": raw.strip()}
            facts["enums"].append(enum_fact)
            if "{" in text and "}" not in text:
                current_enum = enum_fact
            if in_patch(line):
                facts["namedDeclarations"].append(item("enum", name, line, raw))
                facts["namedDeclarations"].extend(item("enumMember", member["name"], line, raw,
                                                        **({"initializer": member["initializer"]}
                                                           if "initializer" in member else {}))
                                                   for member in members)
        namespace_match = _match(r"\bnamespace\s+(" + IDENTIFIER + r")\b", text)
        if namespace_match:
            name = namespace_match.group(1)
            facts["namespaces"].append({"name": name, "line": line})
            if in_patch(line):
                facts["namedDeclarations"].append(item("namespace", name, line, raw))
        function_match = _match(r"^(?:export\s+)?function\s+(" + IDENTIFIER + r")\s*\(([^)]*)\)", text)
        if function_match and in_patch(line):
            facts["namedDeclarations"].append(item("function", function_match.group(1), line, raw))
            parameters(function_match.group(2), line, raw)
        if class_stack and depth == class_stack[-1][1] and in_patch(line):
            property_match = _match(r"^(?:(?:@[\w.]+(?:\([^)]*\))?)\s*)*"
                                    r"(?:(public|private|protected)\s+)?(?:readonly\s+)?("
                                    + IDENTIFIER + r")\s*(?::|=)", text)
            looks_method = _match(r"^" + IDENTIFIER + r"\s*\(", text) or _match(r"\)\s*\{?\s*$", text)
            if property_match and not looks_method and not text.startswith("constructor"):
                name = property_match.group(2)
                facts["classProperties"].append({"relativePath": relative, "line": line, "name": name,
                                                  "text": raw.strip(),
                                                  "hasAccessModifier": bool(property_match.group(1))})
                property_type = _match(r":\s*(" + IDENTIFIER + r")", text)
                facts["namedDeclarations"].append(item("classProperty", name, line, raw,
                                                         **({"typeName": property_type.group(1)}
                                                            if property_type else {})))
            method_match = _match(r"^(?:(?:public|private|protected)\s+)?(?:static\s+)?("
                                  + IDENTIFIER + r")\s*\(([^)]*)\)", text)
            if method_match and not text.startswith("constructor"):
                facts["namedDeclarations"].append(item("method", method_match.group(1), line, raw))
                parameters(method_match.group(2), line, raw)
        variable_match = _match(r"^(let|const|var)\s+(" + IDENTIFIER + r")"
                                r"(?:\s*:\s*(" + IDENTIFIER + r"))?\s*(?:=\s*(.+?))?\s*;?\s*$", text)
        if variable_match and in_patch(line):
            kind, name, type_name, initializer = variable_match.groups()
            extra = {**({"typeName": type_name} if type_name else {}),
                     **({"initializer": initializer} if initializer else {})}
            facts["variableDeclarations"].append({"relativePath": relative, "line": line,
                                                  "kind": kind, "name": name,
                                                  "scope": "topLevel" if depth == 0 else "local",
                                                  **extra, "text": raw.strip()})
            facts["namedDeclarations"].append(item("variable", name, line, raw, **extra))
            if type_name and initializer and initializer.strip().startswith("{"):
                facts["objectLiteralClassInitializations"].append(
                    {"relativePath": relative, "line": line, "className": type_name, "text": raw.strip()})
        cast_match = _match(r"return\s+\{.*\}\s+as\s+(" + IDENTIFIER + r")", text)
        if cast_match and in_patch(line):
            facts["objectLiteralClassInitializations"].append(
                {"relativePath": relative, "line": line, "className": cast_match.group(1), "text": raw.strip()})
        assignment_match = _match(r"^(" + IDENTIFIER + r")\s*(?:[+\-*/%]?=|\+\+|--)", text)
        if assignment_match and not _match(r"^(let|const|var)\b", text):
            facts["assignments"].append({"relativePath": relative, "line": line,
                                         "name": assignment_match.group(1), "text": raw.strip()})
        for char in text:
            if char == "{":
                depth += 1
            elif char == "}":
                depth = max(0, depth - 1)
                while class_stack and depth < class_stack[-1][1]:
                    class_stack.pop()
    return facts


def scan_arkts_light_facts(evidence, extensions=None):
    wanted = {item.lower() for item in (extensions or [".ets"])}
    files = [_scan_file(file) for file in evidence["workspaceFiles"]
             if Path(file["relativePath"]).suffix.lower() in wanted]
    names = lambda key: {item["name"] for file in files for item in file[key]}
    return {"files": files, "classNames": names("classes"), "interfaceNames": names("interfaces"),
            "typeLikeNames": set.union(set(), *(names(key) for key in
                                              ("classes", "interfaces", "typeAliases", "enums", "namespaces"))),
            "namespaceNames": names("namespaces"),
            "valueNames": {item["name"] for file in files for item in file["namedDeclarations"]
                           if item["kind"] in ("function", "method", "variable", "classProperty", "enumMember")}}

"""Count explicit public declarations with syntax trees, without executing a project.

This deliberately measures declaration counts, not API equivalence or behavior.
Constructors, inherited members and external re-exports are outside this version's
scope. Overloads and getter/setter pairs count once per qualified name and file.
"""
from importlib import import_module
from importlib.metadata import version
from pathlib import Path

from pyautorun.harmony_eval.core import inside

CATEGORIES = ("types", "callables", "properties")
EXTENSIONS = {"dart": {".dart"}, "typescript": {".ts", ".tsx", ".ets"},
              "javascript": {".js", ".mjs"}, "java": {".java"}, "kotlin": {".kt"}}
EXCLUDED = {".git", ".hvigor", ".ohpm", ".dart_tool", "node_modules", "oh_modules", "build",
            "test", "tests", "__tests__", "androidTest", "example", "examples", "sample", "samples",
            "evaluation-tests", "grading", "coverage", ".ohostest-runs", ".ohos-adaptation"}


def text(node):
    return node.text.decode("utf-8") if node is not None else ""


def child(node, kind):
    return next((c for c in node.named_children if c.type == kind), None)


def field(node, name="name"):
    return text(node.child_by_field_name(name))


class Declarations:
    def __init__(self, filename, language):
        self.filename, self.language, self.items, self.notes = filename, language, {}, []

    def add(self, kind, name, node, owner=""):
        if not name:
            return
        qualified = owner + "." + name if owner else name
        key = (kind, qualified)
        self.items.setdefault(key, {"kind": kind, "name": qualified, "file": self.filename,
                                    "line": node.start_point.row + 1, "language": self.language})

    def dart(self, node, owner=""):
        for n in node.named_children:
            kind = n.type
            if kind in ("class_definition", "mixin_declaration", "mixin_definition", "extension_declaration", "enum_declaration", "type_alias"):
                name = field(n) or text(child(n, "type_identifier")) or text(child(n, "identifier"))
                if not name or name.startswith("_"):
                    continue
                self.add("types", name, n, owner)
                body = n.child_by_field_name("body") or child(n, "class_body")
                if body is not None:
                    self.dart(body, name)
            elif kind in ("declaration", "method_signature"):
                self.dart(n, owner)
            elif kind in ("function_signature", "getter_signature", "setter_signature"):
                name = field(n)
                if name and not name.startswith("_"):
                    self.add("callables" if kind == "function_signature" else "properties", name, n, owner)
            elif kind in ("initialized_identifier_list", "static_final_declaration_list", "identifier_list"):
                for variable in n.named_children:
                    name_node = variable if variable.type == "identifier" else child(variable, "identifier")
                    name = text(name_node)
                    if name and not name.startswith("_"):
                        self.add("properties", name, variable, owner)
            elif kind == "enum_constant":
                self.add("properties", field(n), n, owner)

    def script(self, node):
        declarations = {}
        for n in node.named_children:
            definition = n.child_by_field_name("declaration") if n.type == "export_statement" else n
            if definition is not None and field(definition):
                declarations[field(definition)] = definition
            if definition is not None and definition.type in ("lexical_declaration", "variable_declaration"):
                for variable in definition.named_children:
                    if variable.type == "variable_declarator":
                        declarations[field(variable)] = variable
        for n in node.named_children:
            if n.type != "export_statement":
                # CommonJS is a separate export model; don't invent a zero count.
                assignment = child(n, "assignment_expression") if n.type == "expression_statement" else None
                left = field(assignment, "left") if assignment is not None else ""
                if left == "module.exports" or left.startswith(("module.exports.", "exports.")):
                    raise ValueError(f"{self.filename}: 暂不支持CommonJS导出，请扩展API提取器")
                continue
            definition = n.child_by_field_name("declaration")
            if definition is not None:
                self.script_declaration(definition)
                continue
            value = n.child_by_field_name("value")
            if value is not None:
                if value.type in ("arrow_function", "function_expression", "generator_function"):
                    self.add("callables", "default", value)
                elif value.type in ("class", "class_declaration"):
                    self.script_declaration(value, "default")
                elif value.type == "identifier" and text(value) in declarations:
                    self.script_declaration(declarations[text(value)], "default")
                else:
                    self.add("properties", "default", value)
                continue
            clause = child(n, "export_clause")
            if n.child_by_field_name("source") is not None or clause is None:
                self.notes.append(f"{self.filename}:{n.start_point.row + 1}: 未展开跨文件re-export；只统计扫描范围内的公开声明")
                continue
            for spec in clause.named_children:
                original, alias = field(spec), field(spec, "alias")
                if original in declarations:
                    self.script_declaration(declarations[original], alias or original)
                else:
                    raise ValueError(f"{self.filename}: 无法解析导出符号 {original}")

    def script_declaration(self, n, alias=""):
        kind, name = n.type, alias or field(n)
        if kind in ("class_declaration", "abstract_class_declaration", "class", "interface_declaration", "enum_declaration", "type_alias_declaration"):
            self.add("types", name or "default", n)
            body = n.child_by_field_name("body")
            if body is not None and kind != "type_alias_declaration":
                self.script_members(body, name or "default")
        elif kind in ("function_declaration", "generator_function_declaration", "function_signature"):
            self.add("callables", name or "default", n)
        elif kind in ("lexical_declaration", "variable_declaration"):
            for variable in n.named_children:
                if variable.type == "variable_declarator":
                    self.script_declaration(variable)
        elif kind == "variable_declarator":
            if n.child_by_field_name("name").type != "identifier":
                raise ValueError(f"{self.filename}: 暂不支持解构导出的API统计")
            value = n.child_by_field_name("value")
            self.add("callables" if value is not None and value.type in ("arrow_function", "function_expression", "generator_function")
                     else "properties", name, n)
        else:
            raise ValueError(f"{self.filename}: 暂不支持的导出声明 {kind}")

    def script_members(self, body, owner):
        for n in body.named_children:
            name = field(n)
            modifiers = {text(c) for c in n.named_children if c.type == "accessibility_modifier"}
            if modifiers & {"private", "protected"} or name.startswith("#"):
                continue
            if name == "constructor":
                parameters = n.child_by_field_name("parameters")
                for parameter in parameters.named_children if parameters is not None else []:
                    access = child(parameter, "accessibility_modifier")
                    if access is not None and text(access) == "public":
                        self.add("properties", field(parameter, "pattern"), parameter, owner)
                continue
            if n.type in ("method_definition", "method_signature", "abstract_method_signature"):
                accessor = any(c.type in ("get", "set") for c in n.children)
                self.add("properties" if accessor else "callables", name, n, owner)
            elif n.type in ("public_field_definition", "field_definition", "property_signature", "enum_assignment"):
                self.add("properties", name, n, owner)
            elif n.type == "property_identifier":
                self.add("properties", text(n), n, owner)

    def java(self, node, owner="", implicit_public=False):
        for n in node.named_children:
            if n.type == "enum_body_declarations":
                self.java(n, owner)
                continue
            modifiers = text(child(n, "modifiers")).split()
            public = n.type == "enum_constant" or "public" in modifiers or (implicit_public and not {"private", "protected"}.intersection(modifiers))
            if not public:
                continue
            name = field(n)
            if n.type in ("class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "annotation_type_declaration"):
                qualified = owner + "." + name if owner else name
                self.add("types", name, n, owner)
                body = n.child_by_field_name("body")
                if body is not None:
                    self.java(body, qualified, n.type in ("interface_declaration", "annotation_type_declaration"))
            elif n.type in ("method_declaration", "annotation_type_element_declaration"):
                self.add("callables", name, n, owner)
            elif n.type in ("field_declaration", "constant_declaration"):
                for variable in n.named_children:
                    if variable.type == "variable_declarator":
                        self.add("properties", field(variable), variable, owner)
            elif n.type == "enum_constant":
                self.add("properties", name, n, owner)

    def kotlin(self, node, owner=""):
        for n in node.named_children:
            modifiers = text(child(n, "modifiers")).split()
            if {"private", "protected", "internal"}.intersection(modifiers):
                continue
            name = field(n) or text(child(n, "identifier"))
            if n.type in ("class_declaration", "object_declaration", "type_alias"):
                if not name:
                    continue
                self.add("types", name, n, owner)
                qualified = owner + "." + name if owner else name
                body = child(n, "class_body") or child(n, "enum_class_body")
                if body is not None:
                    self.kotlin(body, qualified)
                primary = child(n, "primary_constructor")
                parameters = child(primary, "class_parameters") if primary is not None else None
                for parameter in parameters.named_children if parameters is not None else []:
                    if any(c.type in ("val", "var") for c in parameter.children):
                        self.kotlin_property(parameter, qualified)
            elif n.type == "function_declaration":
                self.add("callables", name, n, owner)
            elif n.type in ("property_declaration", "class_parameter"):
                self.kotlin_property(n, owner)
            elif n.type == "companion_object":
                body = child(n, "class_body")
                if body is not None:
                    self.kotlin(body, owner)

    def kotlin_property(self, n, owner):
        if {"private", "protected", "internal"}.intersection(text(child(n, "modifiers")).split()):
            return
        declaration = child(n, "variable_declaration")
        self.add("properties", text(child(declaration if declaration is not None else n, "identifier")), n, owner)


def inventory(project, *, paths=None, languages=None):
    root = Path(project).resolve()
    if not root.is_dir():
        raise ValueError(f"API统计工程不存在: {root}")
    search = [inside(root, p, exists=True) for p in paths] if paths else [root]
    files = sorted({p for start in search for p in ([start] if start.is_file() else start.rglob("*"))
                    if p.is_file() and not any(part in EXCLUDED for part in p.relative_to(root).parts)
                    and not p.name.endswith((".g.dart", ".freezed.dart", ".test.ts", ".spec.ts", ".test.js", ".spec.js"))})
    if languages is None:
        dart_lib = root / "lib"
        if (root / "pubspec.yaml").is_file() and any(p.suffix == ".dart" and dart_lib in p.parents for p in files):
            languages, files = ["dart"], [p for p in files if dart_lib in p.parents]
        elif any(p.suffix == ".ets" for p in files):
            languages = ["typescript"]
        elif any(p.suffix in (".ts", ".tsx") for p in files):
            languages = ["typescript"]
        elif any(p.suffix in (".js", ".mjs") for p in files):
            languages = ["javascript"]
        else:
            languages = [lang for lang in ("dart", "java", "kotlin") if any(p.suffix in EXTENSIONS[lang] for p in files)]
    unknown = set(languages) - EXTENSIONS.keys()
    if unknown:
        raise ValueError(f"不支持的API统计语言: {sorted(unknown)}")
    from tree_sitter import Language, Parser
    parsers, parser_versions, entries, notes, scanned = {}, {}, [], [], []
    for lang in languages:
        module = import_module("tree_sitter_" + lang)
        parser_versions[lang] = version("tree-sitter-" + lang)
        for path in files:
            if path.suffix not in EXTENSIONS[lang]:
                continue
            grammar = "tsx" if path.suffix == ".tsx" else lang
            if grammar not in parsers:
                binding = getattr(module, "language_" + grammar)() if lang == "typescript" else module.language()
                parsers[grammar] = Parser(Language(binding))
            tree = parsers[grammar].parse(path.read_bytes())
            relative = path.relative_to(root).as_posix()
            if tree.root_node.has_error:
                raise ValueError(f"{relative}: 语法解析未完整成功，无法可靠统计公开API（ETS仅支持TypeScript兼容语法）")
            declarations = Declarations(relative, lang)
            getattr(declarations, "script" if lang in ("typescript", "javascript") else lang)(tree.root_node)
            entries.extend(declarations.items.values())
            notes.extend(declarations.notes)
            scanned.append(relative)
    if not scanned:
        raise ValueError("未找到可统计的源码；支持Dart、TypeScript/ETS兼容语法、ES模块JavaScript、Java、Kotlin；可用paths/languages指定范围")
    counts = {kind: sum(item["kind"] == kind for item in entries) for kind in CATEGORIES}
    return {"counts": counts, "total": sum(counts.values()), "apis": sorted(entries, key=lambda e: (e["file"], e["line"], e["name"])),
            "files": scanned, "languages": languages, "parser_versions": parser_versions, "notes": notes,
            "scope": "explicit public source declarations; no constructors, inherited members or external re-export expansion"}

"""Resolve capability references and remove explicitly disabled capabilities."""

import json
import os
import shutil
from copy import deepcopy
from pathlib import Path
from harmonyeval.utils.json5 import read_loose_json5


def merge(first, second):
    result = deepcopy(first)
    for key, value in second.items():
        result[key] = merge(result[key], value) if isinstance(value, dict) and isinstance(result.get(key), dict) else deepcopy(value)
    return result


def read_config(root):
    result = {}
    for name in ("opencode.json", "opencode.jsonc"):
        path = Path(root) / name
        if path.is_file():
            result = merge(result, read_loose_json5(path))
    return result


def resolve_references(config, base, replacement=None):
    config = deepcopy(config)
    base = Path(base).resolve()
    def path_value(value):
        raw = str(value)
        prefix = "file://" if raw.startswith("file://") else ""
        if prefix:
            from urllib.request import url2pathname
            from urllib.parse import urlsplit
            parsed = urlsplit(raw)
            raw = url2pathname(("//" + parsed.netloc if parsed.netloc else "") + parsed.path)
        if not prefix and not raw.startswith((".", "/", "~")):
            return value
        path = Path(raw).expanduser()
        path = (base / path).resolve()
        if replacement and (path == base or base in path.parents):
            path = Path(replacement) / path.relative_to(base)
        return path.as_uri() if prefix or path.suffix in (".js", ".ts", ".mjs") else str(path)
    config["plugin"] = [[path_value(p[0]), *p[1:]] if isinstance(p, list) else path_value(p) for p in config.get("plugin", [])]
    skills = config.get("skills", {})
    if isinstance(skills, dict):
        skills["paths"] = [path_value(p) for p in skills.get("paths", [])]
    import re
    def file_references(value):
        if isinstance(value, dict):
            return {k: file_references(v) for k, v in value.items()}
        if isinstance(value, list):
            return [file_references(v) for v in value]
        if isinstance(value, str):
            return re.sub(r"\{file:([^}]+)\}", lambda m: "{file:" + str((base / m.group(1)).resolve()) + "}", value)
        return value
    return file_references(config)


def remove_owned(config, private, original, target_root, item):
    names = {str(item.get("id", "")), str(item.get("package", ""))}
    if target_root:
        names.add(target_root.name)
        pkg = target_root / "package.json"
        if pkg.is_file():
            names.add(json.loads(pkg.read_text(encoding="utf-8")).get("name", ""))
    names.discard("")
    def owned(value):
        if isinstance(value, list):
            return owned(value[0])
        text = str(value)
        from urllib.parse import unquote
        normalized = unquote(text.removeprefix("file://"))
        parts = set(Path(normalized).parts)
        return (any(text == n or text.startswith(n + "@") or n in parts or Path(normalized).stem == n for n in names)
                or (target_root is not None and (normalized == str(target_root) or normalized.startswith(str(target_root) + os.sep))))
    config["plugin"] = [p for p in config.get("plugin", []) if not owned(p)]
    config.setdefault("skills", {})["paths"] = [p for p in config.get("skills", {}).get("paths", []) if not owned(p)]
    # Both the package directory and auto-discovered wrapper must be absent in without.
    for folder in ("plugins", "plugin", "skills", "skill"):
        root = private / folder
        if not root.is_dir():
            continue
        for path in list(root.iterdir()):
            source = original / folder / path.name
            if owned(path.name) or owned(source.resolve()):
                shutil.rmtree(path) if path.is_dir() else path.unlink()
    for name, definition in list(config.get("agent", {}).items()):
        if owned(name) or owned(definition.get("_managedBy", "")):
            del config["agent"][name]

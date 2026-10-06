"""Light ArkUI component and modifier scanner for Python rule evaluation."""

from pathlib import Path
import re

from .whitebox_rule_text import _mask_comments, _mask_strings


COMPONENT = re.compile(r"\b([A-Z][A-Za-z0-9_]*)\s*\(")
BREAKPOINT = re.compile(r"\b(?:breakpoint|currentBreakpoint|curBp|WidthBreakpoint|Breakpoint|sm|md|lg|xl)\b", re.I)


def _skip_whitespace(content, start):
    while start < len(content) and content[start].isspace():
        start += 1
    return start


def _balanced(content, start, opening, closing):
    depth = 0
    for index in range(start, len(content)):
        if content[index] == opening:
            depth += 1
        elif content[index] == closing:
            depth -= 1
            if depth == 0:
                return index
    return None


def _after_children(content, start):
    start = _skip_whitespace(content, start)
    if start >= len(content) or content[start] != "{":
        return start
    end = _balanced(content, start, "{", "}")
    return (end if end is not None else start) + 1


def _line(content, index):
    return content[:index].count("\n") + 1


def _properties(original, sanitized, start):
    properties = []
    cursor = _after_children(sanitized, start)
    while cursor < len(sanitized):
        cursor = _skip_whitespace(sanitized, cursor)
        if cursor >= len(sanitized) or sanitized[cursor] != ".":
            break
        name_match = re.match(r"[A-Za-z_][A-Za-z0-9_]*", sanitized[cursor + 1:])
        if not name_match:
            break
        name = name_match.group()
        opening = _skip_whitespace(sanitized, cursor + 1 + len(name))
        if opening >= len(sanitized) or sanitized[opening] != "(":
            break
        closing = _balanced(sanitized, opening, "(", ")")
        if closing is None:
            break
        argument = original[opening + 1:closing].strip()
        properties.append({"name": name, "argumentText": argument, "line": _line(sanitized, cursor),
                           "usesBreakpoint": bool(BREAKPOINT.search(argument))})
        cursor = _after_children(sanitized, closing + 1)
    return properties


def _context(original, sanitized, index):
    start = max(0, index - 400)
    original_recent = "\n".join(re.split(r"\r?\n", original[start:index])[-8:])
    sanitized_recent = "\n".join(re.split(r"\r?\n", sanitized[start:index])[-8:])
    if not BREAKPOINT.search(original_recent):
        return {}
    if re.search(r"\bswitch\s*\(", sanitized_recent):
        return {"breakpointContext": "switch", "breakpointCondition": original_recent.strip()}
    if re.search(r"\bif\s*\(", sanitized_recent):
        return {"breakpointContext": "if", "breakpointCondition": original_recent.strip()}
    return {}


def _scan_file(file):
    original = file["content"]
    sanitized = _mask_strings(_mask_comments(original))
    result = []
    for match in COMPONENT.finditer(sanitized):
        opening = match.end() - 1
        closing = _balanced(sanitized, opening, "(", ")")
        if closing is None:
            continue
        result.append({"component": match.group(1), "filePath": file["relativePath"],
                       "line": _line(sanitized, match.start()), "startIndex": match.start(),
                       "endIndex": _after_children(sanitized, closing + 1),
                       "argumentText": original[opening + 1:closing].strip(),
                       "properties": _properties(original, sanitized, closing + 1),
                       **_context(original, sanitized, match.start())})
    return result


def _constants(files):
    result = {}
    patterns = (r"\bstatic\s+readonly\s+([A-Z][A-Z0-9_]*)\s*(?::[^=;]+)?=\s*([^;]+);",
                r"\b(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=;]+)?=\s*([^;]+);")
    for file in files:
        if not file["relativePath"].endswith(".ets"):
            continue
        for pattern in patterns:
            for match in re.finditer(pattern, file["content"]):
                value = match.group(2).strip()
                if value:
                    result[match.group(1)] = value
    return result


def build_arkui_scan_index(files):
    instances = [item for file in files if file["relativePath"].endswith(".ets")
                 for item in _scan_file(file)]
    counts = {}
    for item in instances:
        path = item["filePath"]
        counts[path] = counts.get(path, 0) + 1
    return {"componentInstances": instances, "constants": _constants(files),
            "files": [{"relativePath": path, "componentCount": count}
                      for path, count in counts.items()]}

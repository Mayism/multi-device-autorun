"""ArkUI component property and responsive-expression helpers."""

import math
import re


def _property_end(content, start):
    paren = bracket = brace = 0
    quote = None
    index = start
    while index < len(content):
        char = content[index]
        if quote:
            if char == "\\" and index + 1 < len(content):
                index += 2
                continue
            if char == quote:
                quote = None
            index += 1
            continue
        if char in "'\"`":
            quote = char
        elif char == "(":
            paren += 1
        elif char == ")":
            paren = max(0, paren - 1)
        elif char == "[":
            bracket += 1
        elif char == "]":
            bracket = max(0, bracket - 1)
        elif char == "{":
            brace += 1
        elif char == "}":
            if paren == bracket == brace == 0:
                return index
            brace = max(0, brace - 1)
        elif char == "," and paren == bracket == brace == 0:
            return index
        index += 1
    return len(content)


def object_property(argument, name):
    match = re.search(r"\b" + re.escape(name) + r"\s*:", argument)
    if not match:
        return None
    start = match.end()
    while start < len(argument) and argument[start].isspace():
        start += 1
    return argument[start:_property_end(argument, start)].strip()


def property_value(instance, name):
    for item in instance["properties"]:
        if item["name"] == name:
            return {"name": name, "valueText": item["argumentText"], "line": item["line"],
                    "usesBreakpoint": item["usesBreakpoint"]}
    value = object_property(instance["argumentText"], name)
    if not value and instance["component"] == "SideBarContainer" and name == "type":
        argument = instance["argumentText"].strip()
        if argument and not argument.startswith("{"):
            return {"name": name, "valueText": argument, "line": instance["line"],
                    "usesBreakpoint": responsive_expression(argument)}
    if not value:
        return None
    return {"name": name, "valueText": value, "line": instance["line"],
            "usesBreakpoint": responsive_expression(value)}


def breakpoint_map(value):
    return sum(bool(re.search(r"\b" + name + r"\s*:", value)) for name in ("sm", "md", "lg", "xl")) >= 2


def responsive_expression(value):
    return bool(breakpoint_map(value) or
                re.search(r"\b(?:sm|md|lg|xl)\b", value) or
                re.search(r"\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.BREAKPOINT_(?:SM|MD|LG|XL)\b", value) or
                re.search(r"\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.getValue\s*\(", value) or
                re.search(r"\bnew\s+[A-Za-z_$][\w$]*\s*\([^)]*,[^)]*,[^)]*\)\s*\.getValue\s*\(", value) or
                re.search(r"\b(?:isWideScreen|wideScreen|columnsCount|columnCount)\b", value, re.I))


def _numeric_array(value):
    match = re.fullmatch(r"\s*\[([^\]]*)\]\s*", value)
    if not match or not match.group(1):
        return []
    result = []
    for part in match.group(1).split(","):
        try:
            number = float(part.strip())
        except ValueError:
            continue
        if math.isfinite(number):
            result.append(number)
    return result


def _number_text(value):
    return str(int(value)) if value.is_integer() else str(value)


def resolve_constants(value, index=None):
    constants = (index or {}).get("constants", {})
    def member_array(match):
        numbers = _numeric_array(constants.get(match.group(1), ""))
        offset = int(match.group(2))
        return _number_text(numbers[offset]) if offset < len(numbers) else match.group()
    def name_value(match):
        return constants.get(match.group(1), match.group())
    value = re.sub(r"\b[A-Z][A-Za-z0-9_]*\.([A-Z][A-Z0-9_]*)\[(\d+)\]", member_array, value)
    value = re.sub(r"\b[A-Z][A-Za-z0-9_]*\.([A-Z][A-Z0-9_]*)\b", name_value, value)
    value = re.sub(r"\b([A-Z][A-Z0-9_]*)\[(\d+)\]", member_array, value)
    return re.sub(r"\b([A-Z][A-Z0-9_]*)\b", name_value, value)


def split_arguments(content):
    values = []
    start = paren = bracket = brace = 0
    quote = None
    index = 0
    while index < len(content):
        char = content[index]
        if quote:
            if char == "\\" and index + 1 < len(content):
                index += 2
                continue
            if char == quote:
                quote = None
        elif char in "'\"`":
            quote = char
        elif char == "(":
            paren += 1
        elif char == ")":
            paren = max(0, paren - 1)
        elif char == "[":
            bracket += 1
        elif char == "]":
            bracket = max(0, bracket - 1)
        elif char == "{":
            brace += 1
        elif char == "}":
            brace = max(0, brace - 1)
        elif char == "," and paren == bracket == brace == 0:
            values.append(content[start:index].strip())
            start = index + 1
        index += 1
    values.append(content[start:].strip())
    return [item for item in values if item]


def helper_numbers(value, index=None):
    match = re.search(r"\bnew\s+[A-Za-z_$][\w$]*\s*\(([\s\S]*?)\)\s*\.getValue\s*\(", value)
    if not match or not match.group(1):
        return []
    result = []
    for part in split_arguments(match.group(1)):
        try:
            number = float(resolve_constants(part.strip(), index))
        except ValueError:
            continue
        if math.isfinite(number):
            result.append(number)
    return result


def _stable_template(value):
    if re.search(r"\btemplate", value, re.I):
        return True
    templates = [match.group(1) for match in re.finditer(r'''["']([^"']*fr[^"']*)["']''', value)]
    counts = [len(template.strip().split()) for template in templates if template.strip()]
    return bool(counts and (len(counts) == 1 or responsive_expression(value)))


def non_decreasing(value, index=None):
    if re.fullmatch(r"\s*[0-9]+(?:\.[0-9]+)?\s*", value):
        return True
    numbers = helper_numbers(value, index)
    if len(numbers) >= 2:
        return all(right >= left for left, right in zip(numbers, numbers[1:]))
    numbers = [int(match.group(1)) for name in ("sm", "md", "lg", "xl")
               if (match := re.search(r"\b" + name + r"\s*:\s*([0-9]+)", value))]
    return (responsive_expression(value) or _stable_template(value)) if len(numbers) < 2 else all(
        right >= left for left, right in zip(numbers, numbers[1:]))


def varying_boolean(value, index):
    resolved = resolve_constants(value, index)
    map_values = [match.group(1) for name in ("sm", "md", "lg", "xl")
                  if (match := re.search(r"\b" + name + r"\s*:\s*(true|false)\b", resolved))]
    if len(map_values) >= 2:
        return len(set(map_values)) >= 2
    match = re.search(r"\bnew\s+[A-Za-z_$][\w$]*\s*\(([\s\S]*?)\)\s*\.getValue\s*\(", resolved)
    if not match or not match.group(1):
        return False
    values = [resolve_constants(item.strip(), index) for item in split_arguments(match.group(1))]
    values = [item for item in values if item in ("true", "false")]
    return len(values) >= 2 and len(set(values)) >= 2


def opaque_responsive(value, index=None):
    resolved = resolve_constants(value, index).strip()
    if re.fullmatch(r"__arkAnalyzerOpaque\([^)]+\)", resolved):
        return True
    if not resolved or re.fullmatch(r'''\s*(?:true|false|[0-9]+(?:\.[0-9]+)?|'[^']*'|"[^"]*")\s*''', resolved):
        return False
    if "?" in resolved and ":" in resolved:
        return True
    if breakpoint_map(resolved) or len(helper_numbers(resolved, index)) >= 2:
        return False
    if re.search(r"\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.getValue\s*\(", resolved):
        return True
    if re.search(r"\b(?:currentBreakpoint|breakpoint|Breakpoint|BREAKPOINT_|sm|md|lg|xl)\b", resolved):
        return False
    return bool(re.search(r"\b(?:isLargeScreen|isMediumScreen|isSmallScreen|isWideScreen|wideScreen|columnsCount|columnCount)\b", resolved, re.I)
                or re.search(r"\b(?:ResourceUtil|[A-Za-z_$][\w$]*)\.[A-Za-z_$][\w$]*\s*\(", resolved)
                or re.search(r"\bthis\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(", resolved)
                or (re.fullmatch(r"this\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*", resolved) and
                    re.search(r"(?:displayCount|columns|columnCount|template|lanes|span|width|height)", resolved, re.I)))

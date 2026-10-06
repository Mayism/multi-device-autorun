"""Python evaluators for whitebox text-pattern and project-structure rules."""

from bisect import bisect_right
from pathlib import Path
import re


def _mask_comments(source):
    output = []
    index = 0
    line = block = single = double = template = escaped = False
    while index < len(source):
        current = source[index]
        next_char = source[index + 1] if index + 1 < len(source) else ""
        if line:
            if current == "\n":
                line = False
                output.append("\n")
            else:
                output.append(" ")
            index += 1
            continue
        if block:
            if current == "*" and next_char == "/":
                output.extend((" ", " "))
                block = False
                index += 2
                continue
            output.append("\n" if current == "\n" else " ")
            index += 1
            continue
        if single or double or template:
            output.append(current)
            if escaped:
                escaped = False
            elif current == "\\":
                escaped = True
            elif (single and current == "'") or (double and current == '"') or (template and current == "`"):
                single = double = template = False
            index += 1
            continue
        if current == "/" and next_char == "/":
            output.extend((" ", " "))
            line = True
            index += 2
        elif current == "/" and next_char == "*":
            output.extend((" ", " "))
            block = True
            index += 2
        else:
            if current == "'":
                single = True
            elif current == '"':
                double = True
            elif current == "`":
                template = True
            output.append(current)
            index += 1
    return "".join(output)


def _inside_string(source, target):
    single = double = template = escaped = False
    for current in source[:target]:
        if single or double or template:
            if escaped:
                escaped = False
            elif current == "\\":
                escaped = True
            elif (single and current == "'") or (double and current == '"') or (template and current == "`"):
                single = double = template = False
            continue
        if current == "'":
            single = True
        elif current == '"':
            double = True
        elif current == "`":
            template = True
    return single or double or template


def _mask_strings(source):
    output = []
    single = double = template = escaped = False
    for current in source:
        if single or double or template:
            output.append("\n" if current == "\n" else " ")
            if escaped:
                escaped = False
            elif current == "\\":
                escaped = True
            elif (single and current == "'") or (double and current == '"') or (template and current == "`"):
                single = double = template = False
            continue
        if current == "'":
            single = True
            output.append(" ")
        elif current == '"':
            double = True
            output.append(" ")
        elif current == "`":
            template = True
            output.append(" ")
        else:
            output.append(current)
    return "".join(output)


def _line_starts(source):
    return [0] + [index + 1 for index, char in enumerate(source) if char == "\n"]


def _matching_lines(patterns, source, ignore_strings):
    starts = _line_starts(source)
    return sorted({bisect_right(starts, match.start())
                   for pattern in patterns for match in pattern.finditer(source)
                   if not ignore_strings or not _inside_string(source, match.start())})


def _finally_control_lines(source):
    starts = _line_starts(source)
    lines = set()
    for match in re.finditer(r"\bfinally\s*\{", source, re.ASCII):
        index = match.end()
        depth = 1
        while index < len(source) and depth > 0:
            current = source[index]
            if current == "{":
                depth += 1
                index += 1
            elif current == "}":
                depth -= 1
                index += 1
            else:
                token = re.search(r"\b(?:return|break|continue|throw)\b", source[index:], re.ASCII)
                if not token:
                    break
                token_index = index + token.start()
                brace = re.search(r"[{}]", source[index:])
                if brace and index + brace.start() < token_index:
                    index += brace.start()
                    continue
                lines.add(bisect_right(starts, token_index))
                index = token_index + len(token.group())
    return sorted(lines)


def _match_file(file, patterns, keep_comments, ignore_strings, strip_strings, finally_only):
    content = file["content"] if keep_comments else _mask_comments(file["content"])
    content = _mask_strings(content) if strip_strings else content
    numbers = _finally_control_lines(content) if finally_only else _matching_lines(patterns, content, ignore_strings)
    if "patchLineNumbers" in file and file["patchLineNumbers"] is not None:
        allowed = set(file["patchLineNumbers"])
        numbers = [number for number in numbers if number in allowed]
    if not numbers:
        return None
    original_lines = re.split(r"\r?\n", file["content"])
    locations = [f'{file["relativePath"]}:{number}' for number in numbers]
    snippets = [f'{location}: {original_lines[number - 1].strip() if number <= len(original_lines) else ""}'
                for location, number in zip(locations, numbers)]
    return {"relativePath": file["relativePath"], "lineLocations": locations, "lineSnippets": snippets}


def evaluate_text_rule(rule, evidence):
    config = rule["detector"]["config"]
    extensions = {item.lower() for item in config.get("fileExtensions") or []}
    applicability_texts = [item for item in config.get("applicabilityPatterns") or [] if item]
    pattern_texts = [item for item in config.get("patterns") or [] if item]
    applicability = [re.compile(item, re.MULTILINE | re.ASCII) for item in applicability_texts]
    patterns = [re.compile(item, re.MULTILINE | re.ASCII) for item in pattern_texts]
    keep_comments = any("@ts-ignore" in item or "@ts-nocheck" in item
                        for item in applicability_texts + pattern_texts)
    ignore_strings = config.get("ignoreStringLiteralMatches") is True
    strip_strings = config.get("stripStringLiteralContents") is True
    finally_only = config.get("finallyBlockControlFlowOnly") is True
    files = [file for file in evidence["workspaceFiles"] if Path(file["relativePath"]).suffix.lower() in extensions]

    def matches_for(compiled):
        return [match for file in files
                if (match := _match_file(file, compiled, keep_comments, ignore_strings,
                                         strip_strings, finally_only))]

    if applicability and not matches_for(applicability):
        return {"rule_id": rule["rule_id"], "rule_source": rule["rule_source"], "result": "不涉及",
                "conclusion": "未发现该规则的适用场景。", "matchedFiles": [],
                "matchedLocations": [], "matchedSnippets": []}
    matches = matches_for(patterns)
    matched_files = [match["relativePath"] for match in matches]
    locations = [location for match in matches for location in match["lineLocations"]]
    snippets = [snippet for match in matches for snippet in match["lineSnippets"]]
    conclusion_locations = locations if locations else matched_files
    conclusion = (f'{rule["summary"]} 检测到规则命中，文件：{", ".join(conclusion_locations)}'
                  if matched_files else "检测到规则适用场景，未发现违规命中。" if applicability else
                  "未发现该规则的命中证据。")
    return {"rule_id": rule["rule_id"], "rule_source": rule["rule_source"],
            "result": "不满足" if matched_files else "满足", "conclusion": conclusion,
            "matchedFiles": matched_files, "matchedLocations": locations, "matchedSnippets": snippets}


def evaluate_project_structure_rule(rule, evidence):
    required = rule["detector"]["config"].get("requiredPaths") or []
    paths = {item["relativePath"] for item in evidence["workspaceFiles"]}
    missing = [item for item in required if item not in paths]
    return {"rule_id": rule["rule_id"], "rule_source": rule["rule_source"],
            "result": "不满足" if missing else "满足",
            "conclusion": f'{rule["summary"]} 缺失路径：{", ".join(missing)}' if missing else
                          "项目结构符合该规则要求。", "matchedFiles": missing}

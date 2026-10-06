"""Read the limited JSON5 syntax used by HarmonyOS project metadata."""

import json
from pathlib import Path
import re


def parse_loose_json5(source):
    text = str(source)
    output = []
    index = 0
    in_string = False
    quote = ""
    while index < len(text):
        ch = text[index]
        next_ch = text[index + 1] if index + 1 < len(text) else ""
        if in_string:
            if ch == "\\":
                output.extend((ch, next_ch))
                index += 2
                continue
            output.append('\\"' if quote == "'" and ch == '"' else ch)
            if ch == quote:
                in_string = False
                output[-1] = '"'
            index += 1
            continue
        if ch == "/" and next_ch == "/":
            while index < len(text) and text[index] != "\n":
                index += 1
            continue
        if ch == "/" and next_ch == "*":
            index += 2
            while index < len(text) - 1 and text[index:index + 2] != "*/":
                index += 1
            index += 2
            continue
        if ch in ('"', "'"):
            in_string = True
            quote = ch
            output.append('"')
            index += 1
            continue
        if ch == "," and re.match(r"\s*[}\]]", text[index + 1:]):
            index += 1
            continue
        if re.match(r"[A-Za-z_$]", ch):
            end = index + 1
            while end < len(text) and re.match(r"[\w$]", text[end]):
                end += 1
            word = text[index:end]
            peek = end
            while peek < len(text) and text[peek] in " \t":
                peek += 1
            output.append(json.dumps(word) if text[peek:peek + 1] == ":" and word not in ("true", "false", "null") else word)
            index = end
            continue
        output.append(ch)
        index += 1
    return json.loads("".join(output))


def read_loose_json5(path):
    return parse_loose_json5(Path(path).read_text(encoding="utf-8"))

"""Static precheck for case constraint rules."""

import re


def _unique(values):
    return list(dict.fromkeys(values))


def _matches_target(path, pattern):
    parts = []
    index = 0
    while index < len(pattern):
        if pattern[index:index + 2] == "**":
            parts.append(".*")
            index += 2
        elif pattern[index] == "*":
            parts.append("[^/]*")
            index += 1
        else:
            parts.append(re.escape(pattern[index]))
            index += 1
    return re.search("^" + "".join(parts) + "$", path) is not None


def _requirement(item):
    namespace, separator, remainder = item.partition(":")
    searchable = remainder if separator else item
    symbols = _unique(token for token in re.findall(r"[A-Za-z_$][A-Za-z0-9_$]{2,}", searchable)
                      if len(token) >= 4)
    namespace = namespace.strip() if separator else None
    return {"kind": "arkui" if re.search("arkui", item, re.I) else "external",
            "symbols": symbols, "namespace": namespace or None}


def _patch_content(file):
    if file.get("patchLineNumbers") is None:
        return file["content"]
    lines = re.split(r"\r?\n", file["content"])
    return "\n".join(lines[number - 1] if 0 < number <= len(lines) else ""
                     for number in file["patchLineNumbers"])


def _kit_evidence(files, items):
    matched_tokens = []
    matched_files = []
    strong_count = weak_count = 0
    summaries = []
    for requirement in map(_requirement, items):
        symbols = requirement["symbols"]
        if not symbols:
            continue
        if requirement["kind"] == "arkui":
            matched = []
            for symbol in symbols:
                pattern = re.compile(r"\b" + re.escape(symbol) + r"\b")
                hits = [file for file in files if pattern.search(file["content"])]
                matched_files.extend(file["relativePath"] for file in hits)
                if hits:
                    matched.append(symbol)
            matched_tokens.extend(matched)
            strong = [symbol for symbol in matched if symbol not in ("display", "aspectRatio")]
            weak = [symbol for symbol in matched if symbol in ("display", "aspectRatio")]
            if strong:
                strong_count += 1
                summaries.append("Kit 静态锚点：ArkUI 内置组件或强符号 " + "、".join(strong) + " 已在目标文件中使用。")
                if weak:
                    weak_count += 1
                    summaries.append("Kit 静态锚点：同时发现弱锚点 " + "、".join(weak) + "，仅作为阅读入口。")
            elif weak:
                weak_count += 1
                summaries.append("Kit 静态锚点：仅发现弱锚点 " + "、".join(weak) + "，不能单独证明规则适用或满足。")
            else:
                summaries.append("Kit 静态锚点：ArkUI 内置组件或符号 " + "、".join(symbols) + " 未在目标文件中出现。")
            continue

        def strong_hits(symbol):
            hits = []
            for file in files:
                content = file["content"]
                imports = [line for line in re.split(r"\r?\n", content)
                           if re.search(r"^\s*import\b", line) and re.search("kit", line, re.I)]
                imported = any(symbol in line or
                               (requirement["namespace"] and requirement["namespace"].lower() in line.lower())
                               for line in imports)
                called = bool(requirement["namespace"] and re.search(
                    r"\b" + re.escape(requirement["namespace"]) + r"\s*\.\s*" + re.escape(symbol) + r"\b",
                    content))
                if imported or called:
                    hits.append(file)
            return hits

        strong = []
        weak = []
        for symbol in symbols:
            hits = strong_hits(symbol)
            if hits:
                strong.append(symbol)
                matched_files.extend(file["relativePath"] for file in hits)
        for symbol in symbols:
            if symbol in strong:
                continue
            hits = [file for file in files if symbol in file["content"]]
            if hits:
                weak.append(symbol)
                matched_files.extend(file["relativePath"] for file in hits)
        matched_tokens.extend(strong + weak)
        if strong:
            strong_count += 1
            summaries.append("Kit 静态锚点：发现 external kit/API 的导入或调用链证据：" + "、".join(strong) + "。")
        elif weak:
            weak_count += 1
            summaries.append("Kit 静态锚点：仅发现疑似同名本地方法或弱文本命中：" + "、".join(weak) + "，未发现 external kit/API 来源证据。")
        else:
            summaries.append("Kit 静态锚点：未发现 external kit/API 来源证据：" + "、".join(symbols) + "。")
    return _unique(matched_tokens), _unique(matched_files), strong_count, weak_count, summaries


def evaluate_case_constraint_rule(rule, evidence):
    config = rule["detector"]["config"]
    patterns = config.get("targetPatterns") or []
    signals = config.get("astSignals") or []
    kit = config.get("kit") or []
    files = [file for file in evidence["workspaceFiles"]
             if any(_matches_target(file["relativePath"], pattern) for pattern in patterns)]
    if not files:
        precheck = {"target_matched": False, "target_files": [], "signal_status": "no_target_files",
                    "matched_tokens": [], "summary": "静态预判未找到匹配目标文件。"}
    else:
        matched_tokens = []
        matched_files = []
        matched_signal_count = 0
        requirements = [item for item in map(_requirement, kit) if item["symbols"]]
        kit_tokens, kit_files, strong_count, weak_count, kit_summaries = _kit_evidence(files, kit)
        for signal in signals:
            tokens = [value for key, value in signal.items() if key != "type" and value]
            found = []
            for token in tokens:
                hits = [file for file in files if token in _patch_content(file)]
                matched_files.extend(file["relativePath"] for file in hits)
                if hits:
                    found.append(token)
            if found and len(found) == len(tokens):
                matched_signal_count += 1
            matched_tokens.extend(found)
        matched_tokens.extend(kit_tokens)
        matched_files.extend(kit_files)
        all_ast = bool(matched_signal_count and matched_signal_count == len(signals))
        all_kit = bool(strong_count and requirements)
        status = ("all_matched" if all_ast or all_kit else
                  "partial_matched" if matched_signal_count or weak_count else "none_matched")
        summary = f"静态预判在目标文件中命中了 {matched_signal_count}/{len(signals)} 个 AST 信号。"
        if requirements:
            summary += f" Kit 静态锚点强证据命中 {strong_count}/{len(requirements)}。{''.join(kit_summaries)}"
        precheck = {"target_matched": True, "target_files": [file["relativePath"] for file in files],
                    "matched_files": _unique(matched_files), "signal_status": status,
                    "matched_tokens": _unique(matched_tokens), "summary": summary}
    return {"rule_id": rule["rule_id"], "rule_source": rule["rule_source"],
            "result": "未接入判定器", "conclusion": precheck["summary"] + " 仅作为辅助证据，不作为最终结论。",
            "matchedFiles": precheck.get("matched_files", []),
            "preliminaryData": {"static_precheck": precheck}}

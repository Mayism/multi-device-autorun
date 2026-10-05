"""Explain failed UITest interactions with a separate read-only Agent session."""

from hashlib import sha256
import json
from pathlib import Path
import re

from .case_run import now, write_json
from .session_monitor import run_monitored_session


SCHEMA_VERSION = "autorun-uitest-failure-analysis-v3"
CATEGORIES = {"interaction_failure", "implementation_defect", "test_defect", "environment", "inconclusive"}
CONFIDENCE = {"high", "medium", "low"}


def _text(value):
    return "" if value is None else str(value)


def _read_text(path, limit=120000):
    try:
        content = Path(path).read_text(encoding="utf-8")
        return content[:limit] + (f"\n[内容已截断，共 {len(content)} 字符]" if len(content) > limit else "")
    except (OSError, TypeError):
        return ""


def failure_identity(item):
    fields = [_text(item.get(key)) for key in ("deviceId", "suite", "name", "message", "stack")]
    return sha256(json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()[:16]


def collect_uitest_failures(runner_result):
    failures = []
    for device in (((runner_result or {}).get("runs") or {}).get("swe") or {}).get("devices") or []:
        for suite in device.get("suiteResults") or []:
            for case in suite.get("testCases") or []:
                raw = str(case.get("status") or "").lower()
                code = case.get("statusCode")
                status = "passed" if raw == "passed" or code == 0 else "error" if raw == "error" or code == -1 else "failed"
                if status == "passed":
                    continue
                item = {"deviceId": _text(device.get("id")), "deviceProfile": _text(device.get("profile")),
                        "suite": _text(suite.get("suiteClass") or suite.get("name")),
                        "name": _text(case.get("name")), "status": status,
                        "message": _text(case.get("message")), "stack": _text(case.get("stack"))}
                failures.append({"failureId": failure_identity(item), **item})
    return failures


def _inside(root, candidate):
    root = Path(root).resolve()
    target = Path(candidate).resolve()
    return target == root or root in target.parents


def _stack_location(value):
    text = _text(value)
    match = re.search(r"\((.+?):(\d+):(\d+)\)|\bat\s+(.+?):(\d+):(\d+)\b", text)
    if not match:
        return None
    path, line, column = match.groups()[:3] if match.group(1) else match.groups()[3:]
    return {"relativePath": path.replace("\\", "/"), "line": int(line), "column": int(column),
            "functionName": (re.search(r"\bat\s+([^\s(]+)", text) or ["", ""])[1]}


def _source_from_patch(patch_text, relative):
    marker = "+++ b/" + relative.replace("\\", "/")
    start = patch_text.find(marker)
    if start < 0:
        return ""
    block = re.split(r"^diff --git ", patch_text[start + len(marker):], maxsplit=1, flags=re.M)[0]
    lines, in_hunk = [], False
    for line in block.splitlines():
        if line.startswith("@@"):
            in_hunk = True
        elif in_hunk and line.startswith(("+", " ")) and not line.startswith("+++"):
            lines.append(line[1:])
    return "\n".join(lines)


def interaction_context(failures, project_roots, test_roots, test_patch):
    enriched, fallback = [], []
    for failure in failures:
        location = _stack_location(failure.get("stack"))
        source = ""
        if location:
            for root in test_roots:
                if not root:
                    continue
                candidate = Path(root) / location["relativePath"]
                if _inside(root, candidate):
                    source = _read_text(candidate, 500000)
                    if source:
                        break
            if not source:
                source = _source_from_patch(test_patch, location["relativePath"])
        if not location or not source:
            enriched.append(failure)
            continue
        lines = source.splitlines()
        at = min(max(location["line"] - 1, 0), len(lines) - 1)
        nearby = "\n".join(lines[max(0, at - 5):at + 6])
        selector = re.search(r"ON\.(id|text|type|description|key)\(\s*(['\"`])([^'\"`]+)\2\s*\)",
                             lines[at]) or re.search(r"ON\.(id|text|type|description|key)\(\s*(['\"`])([^'\"`]+)\2\s*\)", nearby)
        if not selector:
            enriched.append(failure)
            continue
        method, value = selector.group(1), selector.group(3)
        action = (re.search(r"\.(click|longClick|inputText|scroll|dragTo|pinchOut|pinchIn)\s*\(", nearby) or ["", "interact"])[1]
        target = {"componentType": "", "clickable": action in ("click", "longClick"),
                  "displayText": value if method == "text" else "", "textResource": "",
                  "sourcePath": "", "sourceLine": 0, "viewSourcePath": "", "resourceSourcePath": ""}
        for root in project_roots:
            if not root or not Path(root).exists():
                continue
            for path in Path(root).rglob("*"):
                if not path.is_file() or path.suffix not in (".ets", ".ts", ".js", ".json", ".json5") or \
                   any(part in (".git", ".hvigor", "build", "node_modules", "ohosTest") for part in path.parts):
                    continue
                content = _read_text(path, 500000)
                if value not in content:
                    continue
                for index, line in enumerate(content.splitlines(), 1):
                    if value in line:
                        target["sourcePath"] = str(path.relative_to(root))
                        target["sourceLine"] = index
                        break
                break
            if target["sourcePath"]:
                break
        not_found = bool(re.search(r"\b(null|undefined)\b", failure["message"], re.I) and
                         "findComponent" in lines[at])
        interaction = {"phase": "前置导航" if re.search(r"enter|open|navigate", location["functionName"], re.I) else "前置交互",
                       "action": action, "lookupApi": (re.search(r"findComponent|waitForComponent|assertComponentExist", lines[at]) or ["findComponent"])[0],
                       "locator": {"type": method, "value": value}, "target": target,
                       "result": {"status": "not_found" if not_found else "interaction_failed",
                                  "returnedValue": "undefined" if "undefined" in failure["message"] else "null" if not_found else ""},
                       "assertion": {"executed": False, "expression": ""},
                       "testSource": location["relativePath"], "testLine": location["line"]}
        summary = (f"{interaction['phase']}失败：测试通过 {method}“{value}”查找可{action}控件，但未完成该操作；"
                   "后续业务断言没有执行，当前结果不足以证明被测功能存在问题。")
        enriched.append({**failure, "interaction": interaction})
        fallback.append({"failureId": failure["failureId"], "category": "interaction_failure",
                         "summary": summary, "uxReason": summary, "expectedBehavior": "找到并操作目标控件后执行被测功能断言。",
                         "actualBehavior": f"通过 {method}“{value}”未完成目标操作。",
                         "technicalCause": "失败发生在业务断言之前；更深层原因证据不足。",
                         "evidence": [f"{location['relativePath']}:{location['line']} 使用 {method}('{value}')"],
                         "confidence": "high", "suggestion": "检查当前页面、控件渲染时机及定位属性。",
                         "interaction": interaction, "source": "deterministic_fallback"})
    return enriched, fallback


def _parse_model_json(text):
    value = text.strip()
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", value, re.I)
    for candidate in (value, fenced.group(1).strip() if fenced else ""):
        if candidate:
            try:
                return json.loads(candidate)
            except ValueError:
                pass
    start, end = value.find("{"), value.rfind("}")
    if start >= 0 and end > start:
        return json.loads(value[start:end + 1])
    raise ValueError("诊断模型未返回 JSON 对象")


def normalize_analyses(raw, failures):
    expected = {item["failureId"]: item for item in failures}
    analyses, seen = [], set()
    for item in raw.get("analyses") or []:
        identifier = _text(item.get("failureId")).strip()[:64]
        if identifier not in expected or identifier in seen:
            continue
        reason = _text(item.get("uxReason") or item.get("summary")).strip()[:2000]
        if not reason:
            continue
        seen.add(identifier)
        result = {"failureId": identifier,
                  "category": item.get("category") if item.get("category") in CATEGORIES else "inconclusive",
                  "summary": reason, "uxReason": reason,
                  **{key: _text(item.get(key)).strip()[:limit] for key, limit in
                     (("expectedBehavior", 1500), ("actualBehavior", 1500), ("technicalCause", 2000), ("suggestion", 2000))},
                  "evidence": [_text(value).strip()[:1000] for value in (item.get("evidence") or [])[:6] if _text(value).strip()],
                  "confidence": item.get("confidence") if item.get("confidence") in CONFIDENCE else "low"}
        if expected[identifier].get("interaction"):
            result["interaction"] = expected[identifier]["interaction"]
        analyses.append(result)
    if not analyses:
        raise ValueError("诊断 JSON 中没有可匹配的失败项")
    return analyses


def _diagnostic_prompt(evidence):
    return ("你是 UITest 失败诊断器，只负责分析，不修改代码或调用工具。请基于证据说明用户预期、实际行为和原因。"
            "若证据不足，选择 inconclusive。不得使用 golden patch。只输出 JSON 对象："
            '{"analyses":[{"failureId":"输入 ID","category":"interaction_failure|implementation_defect|test_defect|environment|inconclusive",'
            '"uxReason":"具体 UX 失败原因","expectedBehavior":"预期","actualBehavior":"实际",'
            '"technicalCause":"技术原因","evidence":["证据"],"confidence":"high|medium|low","suggestion":"建议"}]}\n\n'
            + evidence)


async def analyze_uitest_failures(client, model, case_info, agent_result, ohos_test):
    try:
        runner = json.loads(Path(ohos_test["resultPath"]).read_text(encoding="utf-8"))
    except (OSError, ValueError, KeyError):
        return None
    collected = collect_uitest_failures(runner)
    if not collected:
        return None
    output_dir = Path(agent_result["resultPath"]).parent / "failure-analysis"
    output_dir.mkdir(parents=True, exist_ok=True)
    result_path = output_dir / "failure-analysis.json"
    evidence_path = output_dir / "evidence.md"
    output_path = output_dir / "model-output.txt"
    failures, fallback, diagnostic_agent = collected, [], ""
    try:
        generated_patch = _read_text(agent_result.get("patchPath"), 35000)
        test_patch = _read_text(ohos_test.get("testPatchPath"), 35000)
        retained = str(Path(ohos_test.get("outputDir") or "") / "work" / "project")
        failures, fallback = interaction_context(collected,
                     [agent_result.get("projectDir"), ohos_test.get("workDir"), retained],
                     [ohos_test.get("workDir"), retained, agent_result.get("projectDir")], test_patch)
        sections = [("失败项", json.dumps(failures, ensure_ascii=False, indent=2)),
                    ("需求 PROMPT.md", _read_text(case_info.get("promptPath"), 14000)),
                    ("metadata.json", _read_text(ohos_test.get("metadataPath"), 12000)),
                    ("Agent changes.patch", generated_patch), ("test_patch.patch", test_patch),
                    ("ohosTest 摘要", _read_text(ohos_test.get("summaryPath"), 12000)),
                    ("ohosTest 命令日志", _read_text(Path(ohos_test.get("outputDir") or "") / "commands.jsonl", 32000))]
        evidence = "\n\n".join(f"## {title}\n\n{content or '（缺失）'}" for title, content in sections)[:120000]
        evidence_path.write_text(evidence + "\n", encoding="utf-8")
        session = await client.create_session(str(output_dir), 120)
        session_id = str((session or {}).get("id") or "")
        if not session_id:
            raise RuntimeError("OpenCode 创建失败诊断 session 后未返回 session id")
        try:
            server_config = await client.get_config(30, str(output_dir))
        except Exception:
            server_config = {}
        agents = server_config.get("agent") or {}
        diagnostic_agent = next((value for value in ("build", "general", agent_result.get("agent")) if value in agents),
                                agent_result.get("agent") or "")
        payload = {"parts": [{"type": "text", "text": _diagnostic_prompt(evidence)}],
                   "model": {"providerID": model["providerId"], "modelID": model["modelId"]}}
        if diagnostic_agent:
            payload["agent"] = diagnostic_agent
        monitored = await run_monitored_session(client, session_id, str(output_dir), payload,
                output_dir / "opencode-sse.jsonl", output_dir / "opencode-polling.jsonl",
                idle_timeout_sec=180, max_runtime_sec=600)
        output = _text(monitored.get("output"))
        output_path.write_text(output, encoding="utf-8")
        model_analyses = normalize_analyses(_parse_model_json(output), failures)
        merged = {item["failureId"]: item for item in fallback}
        merged.update({item["failureId"]: {**merged.get(item["failureId"], {}), **item} for item in model_analyses})
        result = {"schemaVersion": SCHEMA_VERSION, "status": "completed", "generatedAt": now(),
                  "case": case_info.get("name") or agent_result.get("case"),
                  "model": {"providerId": model["providerId"], "modelId": model["modelId"], "agent": diagnostic_agent},
                  "sessionId": session_id, "evidencePath": str(evidence_path), "outputPath": str(output_path),
                  "failures": failures, "analyses": list(merged.values())}
        write_json(result_path, result)
        return {"status": "completed", "resultPath": str(result_path), "evidencePath": str(evidence_path),
                "outputPath": str(output_path), "sessionId": session_id}
    except Exception as error:
        result = {"schemaVersion": SCHEMA_VERSION, "status": "partial" if fallback else "failed",
                  "generatedAt": now(), "case": case_info.get("name") or agent_result.get("case"),
                  "model": {"providerId": model.get("providerId") or "", "modelId": model.get("modelId") or "",
                            "agent": diagnostic_agent}, "error": str(error), "failures": failures,
                  "analyses": fallback}
        write_json(result_path, result)
        return {"status": result["status"], "resultPath": str(result_path),
                "evidencePath": str(evidence_path), "outputPath": str(output_path), "error": str(error)}

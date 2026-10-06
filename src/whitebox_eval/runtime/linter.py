"""Parse, scope and run the external official HarmonyOS Code Linter from Python."""

import json
from pathlib import Path
import re
import shutil
import subprocess
import time

from pyautorun.whitebox_eval.rules.rule_evidence import _visible_files
from pyautorun.whitebox_eval.resources import ROOT as RESOURCES


RULE_SETS = ["plugin:@typescript-eslint/recommended", "plugin:@security/recommended",
             "plugin:@performance/recommended", "plugin:@hw-stylistic/recommended"]
RANK = {"unknown": 0, "suggestion": 1, "warn": 2, "error": 3}


def rule_sets(cross_device):
    values = list(RULE_SETS)
    if (cross_device or {}).get("applicability") == "involved":
        values.append("plugin:@cross-device-app-dev/recommended")
    return values


def build_linter_config(cross_device=None):
    profiles_path = RESOURCES / "official_profiles.json"
    profiles = json.loads(profiles_path.read_text(encoding="utf-8"))
    suggestion = {item["ruleId"]: "suggestion" for item in profiles
                  if item["ruleId"].startswith(("@performance/", "@hw-stylistic/"))}
    return {"files": ["**/*.ets", "**/*.ts", "**/*.js", "**/*.json", "**/*.json5"],
            "ignore": ["node_modules/**/*", "oh_modules/**/*", "build/**/*", ".preview/**/*",
                       "src/ohosTest/**/*", "src/test/**/*", "hvigorfile.ts", "hvigorfile.js",
                       "BuildProfile.ets"],
            "ruleSet": rule_sets(cross_device), "rules": suggestion}


def prepare_linter_workspace(generated, case_dir, cross_device=None):
    artifact = Path(case_dir) / "intermediate" / "code-linter"
    workspace = artifact / "workspace"
    if workspace.exists():
        shutil.rmtree(workspace)
    workspace.mkdir(parents=True)
    copied = []
    for relative in _visible_files(generated):
        if "/src/ohosTest/" in "/" + relative or "/src/test/" in "/" + relative:
            continue
        source = Path(generated) / relative
        target = workspace / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        copied.append(relative)
    config = json.dumps(build_linter_config(cross_device), ensure_ascii=False, indent=2) + "\n"
    path = artifact / "code-linter.json5"
    path.write_text(config, encoding="utf-8")
    (workspace / "code-linter.json5").write_text(config, encoding="utf-8")
    return {"workspaceDir": str(workspace), "configPath": str(path),
            "workspaceConfigPath": str(workspace / "code-linter.json5"), "copiedFiles": copied}


def _severity(value):
    if str(value).lower() in ("2", "error"):
        return "error"
    if str(value).lower() in ("1", "warn"):
        return "warn"
    if str(value).lower() in ("0", "suggestion"):
        return "suggestion"
    return "unknown"


def _rule_set(rule_id):
    for prefix in ("@security/", "@performance/", "@hw-stylistic/", "@typescript-eslint/",
                   "@cross-device-app-dev/"):
        if rule_id.startswith(prefix):
            return "plugin:" + prefix[:-1] + "/recommended"
    return "unknown"


def _number(value):
    try:
        return float(value) if value is not None else 0 if value == 0 else None
    except (TypeError, ValueError):
        return None


def _json_findings(text):
    try:
        parsed = json.loads(text)
    except ValueError:
        return None
    records = parsed if isinstance(parsed, list) else parsed.get("results") if isinstance(parsed, dict) else None
    if not isinstance(records, list):
        return None
    findings = []
    for record in records:
        if not isinstance(record, dict):
            continue
        file = str(record.get("filePath") or record.get("file") or "")
        for message in record.get("messages") or []:
            if not isinstance(message, dict):
                continue
            rule = str(message.get("ruleId") or message.get("rule_id") or message.get("rule") or "")
            if not file or not rule:
                continue
            findings.append({"rule_id": rule, "message": str(message.get("message") or ""),
                             "severity": _severity(message.get("severity")), "file": file,
                             "line": _number(message.get("line")), "column": _number(message.get("column")),
                             "source_rule_set": _rule_set(rule)})
    return findings


def parse_linter_output(stdout, stderr=""):
    raw = stdout.strip()
    found = _json_findings(raw) if raw else None
    if found is None:
        for line in re.sub(r"\x1b\[[0-9;]*m", "", raw).splitlines():
            if line.lstrip().startswith(("[", "{")):
                found = _json_findings(line.strip())
                if found is not None:
                    break
    if found is not None:
        return {"status": "parsed", "findings": found}
    findings = []
    pattern = re.compile(r"^(.+?):(\d+):(\d+)\s+(error|warn|warning|suggestion)\s+(.+?)\s+(@[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+)\s*$")
    for line in (stdout + "\n" + stderr).splitlines():
        match = pattern.fullmatch(line)
        if match:
            file, line_number, column, severity, message, rule = match.groups()
            findings.append({"file": file, "line": int(line_number), "column": int(column),
                             "severity": _severity("warn" if severity == "warning" else severity),
                             "message": message, "rule_id": rule, "source_rule_set": _rule_set(rule)})
    return {"status": "parsed" if findings else "unparsed", "findings": findings}


def normalize_linter_path(path, workspace):
    workspace = str(Path(workspace).resolve()).replace("\\", "/").rstrip("/")
    normalized = str(Path(path).resolve()) if Path(path).is_absolute() else path
    normalized = normalized.replace("\\", "/")
    if normalized == workspace:
        normalized = ""
    elif normalized.startswith(workspace + "/"):
        normalized = normalized[len(workspace) + 1:]
    return re.sub(r"^(?:workspace/|generated/|\./)", "", normalized)


def map_linter_findings(findings, workspace, has_patch, changed_files, changed_lines=None):
    changed = {normalize_linter_path(path, workspace) for path in changed_files}
    lines = {normalize_linter_path(path, workspace): set(numbers)
             for path, numbers in (changed_lines or {}).items()}
    effective = []
    seen = set()
    for finding in findings:
        item = {**finding, "file": normalize_linter_path(finding["file"], workspace)}
        if has_patch and changed and (item["file"] not in changed or
            item["file"] in lines and item.get("line") not in lines[item["file"]]):
            continue
        key = (item["rule_id"], item["file"], item.get("line"), item.get("column"), item["message"])
        if key in seen:
            continue
        seen.add(key)
        effective.append(item)
    groups = {}
    for finding in effective:
        groups.setdefault(finding["rule_id"], []).append(finding)
    results = []
    for rule, group in groups.items():
        locations = [item["file"] + (":" + str(int(item["line"])) +
                     (":" + str(int(item["column"])) if item.get("column") is not None else "")
                     if item.get("line") is not None else "") for item in group[:5]]
        extra = len(group) - len(locations)
        conclusion = (f"官方 Code Linter {rule} 命中 {len(group)} 处：" + "；".join(locations) +
                      (f"；另有 {extra} 处同类问题。" if extra else "") + "。" +
                      ("示例：" + group[0]["message"] if group[0]["message"] else ""))
        results.append({"rule_id": "OFFICIAL-LINTER:" + rule,
                        "rule_summary": "官方 Code Linter：" + rule,
                        "rule_source": "forbidden_pattern" if rule.startswith("@security/") else "should_rule",
                        "result": "不满足", "conclusion": conclusion,
                        "official_linter_severity": max((item["severity"] for item in group), key=RANK.get)})
    return {"effectiveFindings": effective, "ruleResults": results}


def run_linter(run_dir, workspace, timeout_ms):
    started = time.monotonic()
    run_dir = Path(run_dir)
    wrapper = run_dir / "bin" / "codelinter"
    if wrapper.is_file():
        command = [str(wrapper), "-c", "code-linter.json5", "-f", "json", "."]
        cwd = workspace
    else:
        command = ["node", "./index.js", str(workspace)]
        cwd = run_dir
    try:
        completed = subprocess.run(command, cwd=cwd, capture_output=True,
                                   timeout=timeout_ms / 1000, check=False)
        status = "success" if completed.returncode == 0 else "failed"
    except subprocess.TimeoutExpired as error:
        completed = error
        status = "timeout"
    return {"status": status,
            "stdout": (completed.stdout or b"").decode("utf-8", errors="replace"),
            "stderr": (completed.stderr or b"").decode("utf-8", errors="replace"),
            "exitCode": getattr(completed, "returncode", None),
            "durationMs": int((time.monotonic() - started) * 1000)}

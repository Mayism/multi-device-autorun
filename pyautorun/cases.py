"""Find runnable native and H5 Autorun cases."""

import json
import os
from pathlib import Path

from .agent_case_workspace import normalize_case_platform


def discover_cases(cases_root, require_ohostest=False):
    root = Path(cases_root)
    if not root.exists():
        raise ValueError(f"casesRoot 不存在: {root}")
    runnable = []
    skipped = []
    for case in sorted((item for item in root.iterdir() if item.is_dir()), key=lambda item: item.name):
        issues = []
        project_name = next((name for name in ("base", "task") if (case / name).is_dir()), "")
        project_dir = case / project_name if project_name else None
        if not project_name:
            issues.append("缺少 base/ 或 task/ 工程目录")
        prompt = case / "PROMPT.md"
        try:
            if not prompt.read_text(encoding="utf-8").strip():
                issues.append("PROMPT.md 为空")
        except (OSError, UnicodeError):
            issues.append("缺少 PROMPT.md")
        try:
            metadata = json.loads((case / "metadata.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            metadata = None
            if require_ohostest:
                issues.append("缺少或无法解析 metadata.json")
        platform = normalize_case_platform(metadata)
        web_dir = case / "web" if platform == "web" else None
        if web_dir and not web_dir.is_dir():
            issues.append("metadata.platform=web 时缺少 web/ 工程目录")
        if require_ohostest and metadata:
            for field in ("base_project", "test_patch", "golden_patch"):
                if not metadata.get(field):
                    issues.append(f"metadata.json 缺少 {field}")
            for field in ("test_patch", "golden_patch"):
                relative = str(metadata.get(field) or "").strip()
                if relative and not (case / relative).exists():
                    issues.append(f"缺少 {relative}")
            if project_dir and metadata.get("base_project"):
                configured = os.path.abspath(os.path.join(str(case), str(metadata["base_project"])))
                if configured != os.path.abspath(project_dir):
                    issues.append(f"metadata.base_project 必须指向实际工程 {project_name}")
        item = {"name": case.name, "caseRoot": str(case), "projectName": project_name,
                "projectDir": str(project_dir) if project_dir else "", "promptPath": str(prompt),
                "platform": platform, "webProjectDir": str(web_dir) if web_dir else ""}
        if issues:
            skipped.append({**item, "skipReason": "；".join(issues)})
        else:
            runnable.append(item)
    if not runnable:
        details = "；".join(f"{item['name']}: {item['skipReason']}" for item in skipped)
        raise ValueError(f"未发现可执行用例{'（' + details + '）' if details else ''}")
    return {"runnable": runnable, "skipped": skipped}

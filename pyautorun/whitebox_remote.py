"""Download and evaluate management-console whitebox tasks in Python."""

import argparse
from datetime import datetime, timezone
from io import BytesIO
import json
import os
from pathlib import Path, PurePosixPath
import shutil
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from urllib.parse import urlsplit
from uuid import uuid4
from zipfile import ZipFile, BadZipFile

from .whitebox_local import run_local_whitebox


TASK_TYPES = {"new_development": "full_generation", "incremental": "continuation",
              "bugfix": "bug_fix", "full_generation": "full_generation",
              "continuation": "continuation", "bug_fix": "bug_fix"}
MAX_PROJECT_BYTES = 128 * 1024 * 1024


def _safe_target(root, relative):
    if not isinstance(relative, str) or not relative or "\x00" in relative:
        raise ValueError("remote project file path is invalid")
    posix = PurePosixPath(relative.replace("\\", "/"))
    if posix.is_absolute() or any(part in ("", ".", "..") for part in posix.parts) or ":" in posix.parts[0]:
        raise ValueError(f"remote project contains unsafe path: {relative}")
    target = Path(root).joinpath(*posix.parts)
    if not target.resolve().is_relative_to(Path(root).resolve()):
        raise ValueError(f"remote project contains unsafe path: {relative}")
    return target


def _fetch(url, max_bytes=MAX_PROJECT_BYTES):
    if not isinstance(url, str) or not url.strip():
        raise ValueError("remote project URL is required")
    if urlsplit(url).scheme not in ("http", "https"):
        raise ValueError("remote project URL must use HTTP or HTTPS")
    with urlopen(Request(url), timeout=180) as response:
        content = response.read(max_bytes + 1)
        kind = response.headers.get("Content-Type", "")
    if len(content) > max_bytes:
        raise ValueError("remote project exceeds size limit")
    return content, kind


def download_project(url, destination, *, fetch=_fetch):
    """Read a JSON file manifest or ZIP into a new project directory."""
    content, kind = fetch(url)
    root = Path(destination)
    root.mkdir(parents=True, exist_ok=True)
    written = []
    if "zip" in kind.lower() or url.lower().endswith(".zip") or content.startswith(b"PK\x03\x04"):
        try:
            with ZipFile(BytesIO(content)) as archive:
                if sum(item.file_size for item in archive.infolist()) > MAX_PROJECT_BYTES:
                    raise ValueError("remote archive exceeds extracted size limit")
                for item in archive.infolist():
                    target = _safe_target(root, item.filename)
                    if item.is_dir():
                        target.mkdir(parents=True, exist_ok=True)
                        continue
                    # ZIP symlinks must not be materialized as project files.
                    if ((item.external_attr >> 16) & 0o170000) == 0o120000:
                        raise ValueError("remote archive contains a symlink")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(item) as source, target.open("wb") as output:
                        shutil.copyfileobj(source, output)
                    written.append(str(target))
        except BadZipFile as error:
            raise ValueError("remote archive is invalid") from error
    else:
        try:
            manifest = json.loads(content)
        except ValueError as error:
            raise ValueError("remote project manifest is invalid JSON") from error
        files = manifest.get("files") if isinstance(manifest, dict) else None
        if not isinstance(files, list) or not files:
            raise ValueError("remote project manifest files must be a nonempty array")
        for item in files:
            if not isinstance(item, dict) or not isinstance(item.get("content"), str):
                raise ValueError("remote project manifest file is invalid")
            target = _safe_target(root, item.get("path"))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(item["content"], encoding="utf-8")
            written.append(str(target))
    if not written:
        raise ValueError("remote project contains no files")
    return written


def validate_remote_task(task):
    if not isinstance(task, dict) or isinstance(task.get("taskId"), bool) or not isinstance(task.get("taskId"), int):
        raise ValueError("taskId must be an integer")
    case = task.get("testCase")
    execution = task.get("executionResult")
    if not isinstance(case, dict) or not isinstance(execution, dict):
        raise ValueError("testCase and executionResult are required")
    if case.get("type") not in TASK_TYPES:
        raise ValueError("unsupported remote task type")
    if isinstance(case.get("id"), bool) or not isinstance(case.get("id"), int):
        raise ValueError("testCase.id must be an integer")
    for key in ("name", "fileUrl"):
        if not isinstance(case.get(key), str):
            raise ValueError(f"testCase.{key} must be a string")
    if not isinstance(execution.get("outputCodeUrl"), str) or not execution["outputCodeUrl"]:
        raise ValueError("executionResult.outputCodeUrl must be a URL")
    if not isinstance(execution.get("isBuildSuccess"), bool):
        raise ValueError("executionResult.isBuildSuccess must be a boolean")
    return task


def remote_prompt(task):
    case = task["testCase"]
    return "\n\n".join(f"{label}：{case.get(key)}" for key, label in
                       (("description", "任务描述"), ("input", "输入要求"),
                        ("expectedOutput", "期望输出")) if case.get(key))


def _expected_constraints(text):
    if not isinstance(text, str) or not text.strip():
        return False
    try:
        import yaml
        parsed = yaml.safe_load(text)
    except ImportError:
        return False
    except yaml.YAMLError:
        return False
    return isinstance(parsed, list) or isinstance(parsed, dict) and isinstance(parsed.get("constraints"), list)


def prepare_remote_task(task, case_dir, *, fetch=_fetch):
    validate_remote_task(task)
    case_dir = Path(case_dir)
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / "inputs").mkdir(exist_ok=True)
    (case_dir / "inputs" / "remote-task.json").write_text(
        json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")
    project_root = case_dir / "inputs" / "remote-project"
    original = project_root / "original"
    generated = project_root / "workspace"
    original.mkdir(parents=True, exist_ok=True)
    if task["testCase"]["fileUrl"].strip():
        download_project(task["testCase"]["fileUrl"], original, fetch=fetch)
    download_project(task["executionResult"]["outputCodeUrl"], generated, fetch=fetch)
    prompt = project_root / "input.txt"
    prompt.write_text(remote_prompt(task), encoding="utf-8")
    manifest = {"schemaVersion": "whitebox-input-v1", "caseId": str(task["taskId"]),
                "taskType": TASK_TYPES[task["testCase"]["type"]], "promptPath": str(prompt),
                "originalProjectPath": str(original), "generatedProjectPath": str(generated),
                "outputDir": str(case_dir),
                "remoteBuildSuccess": task["executionResult"]["isBuildSuccess"]}
    expected = task["testCase"].get("expectedOutput")
    if _expected_constraints(expected):
        path = project_root / "expected_constraints.yaml"
        path.write_text(expected, encoding="utf-8")
        manifest["expectedConstraintsPath"] = str(path)
    (case_dir / "inputs" / "input.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def callback_payload(task_id, status, result=None, error=None):
    payload = {"taskId": task_id, "status": status}
    if status == "completed" and result:
        conclusion = result.get("overall_conclusion") or {}
        payload.update({"success": True, "totalScore": conclusion.get("total_score", 0),
                        "maxScore": conclusion.get("max_score", 100),
                        "resultData": {"basic_info": result.get("basic_info") or {},
                                       "overall_conclusion": conclusion}})
    if error:
        payload["errorMessage"] = str(error)
    return payload


def post_callback(endpoint, payload):
    if not endpoint:
        return {"uploaded": False, "message": "未提供 callback，已跳过回传。"}
    if urlsplit(endpoint).scheme not in ("http", "https"):
        raise ValueError("callback URL must use HTTP or HTTPS")
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    try:
        with urlopen(Request(endpoint, data=body, headers={"Content-Type": "application/json"},
                             method="POST"), timeout=30) as response:
            if response.status < 200 or response.status >= 300:
                return {"uploaded": False, "message": f"上传失败，状态码：{response.status}"}
    except HTTPError as error:
        return {"uploaded": False, "message": f"上传失败，状态码：{error.code}"}
    return {"uploaded": True, "message": "callback 上传成功。"}


def run_remote_task(task, *, local_case_root=None, evaluator=run_local_whitebox, fetch=_fetch,
                    callback=post_callback, case_dir=None):
    validate_remote_task(task)
    root = Path(local_case_root or os.environ.get("LOCAL_CASE_ROOT", ".local-cases")).resolve()
    name = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + f'_case_{task["taskId"]}_{uuid4().hex[:8]}'
    case_dir = Path(case_dir) if case_dir is not None else root / name
    try:
        manifest = prepare_remote_task(task, case_dir, fetch=fetch)
        callback(task.get("callback"), callback_payload(task["taskId"], "running"))
        summary = evaluator(manifest)
        result = json.loads(Path(summary["resultPath"]).read_text(encoding="utf-8"))
        uploaded = callback(task.get("callback"), callback_payload(task["taskId"], "completed", result))
        return {**summary, "taskId": task["taskId"], "caseDir": str(case_dir),
                "uploadMessage": uploaded["message"]}
    except Exception as error:
        try:
            callback(task.get("callback"), callback_payload(task["taskId"], "failed", error=error))
        except Exception:
            pass
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run a remote whitebox task with the Python evaluator")
    parser.add_argument("--input", required=True, help="Remote task JSON file")
    parser.add_argument("--case-root")
    args = parser.parse_args(argv)
    task = json.loads(Path(args.input).read_text(encoding="utf-8"))
    result = run_remote_task(task, local_case_root=args.case_root)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

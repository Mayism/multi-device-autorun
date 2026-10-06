"""Prepare native and H5 case workspaces without the Node runtime."""

from pathlib import Path
import shutil

from pyautorun.orchestration.sandbox_copy import copy_project


def normalize_case_platform(metadata):
    return str((metadata or {}).get("platform") or "native").strip().lower() or "native"


def agent_case_layout(case_info, case_run_dir):
    platform = normalize_case_platform(case_info)
    web = platform == "web"
    run = Path(case_run_dir)
    project = run / ("project" if web else case_info["projectName"])
    return {"platform": platform, "web": web, "originalDir": str(run / "original"),
            "projectDir": str(project),
            "buildProjectDir": str(project / case_info["projectName"] if web else project)}


def copy_case_source_snapshot(case_info, destination):
    destination = Path(destination)
    if normalize_case_platform(case_info) != "web":
        copy_project(case_info["projectDir"], destination)
        return
    if not case_info.get("webProjectDir"):
        raise ValueError(f"Web 用例 {case_info.get('name')} 缺少 web 工程目录")
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    copy_project(case_info["projectDir"], destination / case_info["projectName"])
    copy_project(case_info["webProjectDir"], destination / "web")


def prepare_agent_case_workspace(case_info, layout):
    copy_case_source_snapshot(case_info, layout["originalDir"])
    copy_project(layout["originalDir"], layout["projectDir"])


def materialize_agent_case_projects(case_info, layout, case_run_dir):
    if not layout["web"]:
        return
    copy_project(Path(layout["projectDir"]) / case_info["projectName"],
                 Path(case_run_dir) / case_info["projectName"])
    copy_project(Path(layout["projectDir"]) / "web", Path(case_run_dir) / "web")

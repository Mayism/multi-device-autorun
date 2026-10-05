"""Python CLI for AGC cloud-test submission and existing-task polling."""

import argparse
from pathlib import Path

from .cloudtest_poll import poll_existing_task
from .cloudtest_submit import run_cloud_test
from .config import load_autorun_config


def main(argv=None):
    parser = argparse.ArgumentParser(description="Autorun 云测试")
    parser.add_argument("--config", "-c", default="./config/autorun.config.json")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--cloud-test", action="store_true")
    mode.add_argument("--poll-task", metavar="TASK_GROUP_ID")
    parser.add_argument("--case", dest="case_name", default="")
    parser.add_argument("--project", default="")
    parser.add_argument("--project-dir", default="")
    parser.add_argument("--app", default="")
    parser.add_argument("--task-name", default="")
    args = parser.parse_args(argv)
    if args.poll_task:
        if not args.poll_task.isdigit():
            parser.error("--poll-task 需要纯数字任务组 ID")
        if args.case_name or args.project or args.project_dir or args.app or args.task_name:
            parser.error("--poll-task 不能同时指定用例或安装包")
    elif not (args.case_name or args.project_dir or args.app):
        parser.error("--cloud-test 需要 --case、--project-dir 或 --app 之一")
    elif args.project_dir and args.case_name:
        parser.error("--project-dir 不能和 --case 一起使用")
    config = load_autorun_config(args.config)
    if args.poll_task:
        result = poll_existing_task(config, args.poll_task)
    else:
        project_dir = Path(args.project_dir).absolute() if args.project_dir else None
        if args.case_name:
            case_root = Path(config["execution"]["casesRoot"]) / args.case_name
            if not case_root.is_dir():
                raise ValueError(f"用例不存在: {case_root}")
            project_name = args.project or ("base" if (case_root / "base").is_dir() else "task")
            project_dir = case_root / project_name
            if not project_dir.is_dir():
                raise ValueError(f"用例工程目录不存在: {project_dir}")
        result = run_cloud_test(config, project_dir=str(project_dir or ""), app_path=args.app,
                                case_name=args.case_name, task_name=args.task_name)
    return 0 if result["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

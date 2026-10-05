"""Python Autorun command line entry point."""

import argparse
import asyncio
from pathlib import Path
import sys

from .app import run_autorun
from .cloudtest_cli import main as cloudtest_main
from .config import load_autorun_config
from .preflight import check_environment
from .reports import merge_overview


def main(argv=None):
    parser = argparse.ArgumentParser(description="Autorun Python 运行入口")
    parser.add_argument("--config", "-c", default="./config/autorun.config.json")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--retry")
    parser.add_argument("--merge", nargs="?", const="")
    parser.add_argument("--cloud-test", action="store_true")
    parser.add_argument("--poll-task")
    parser.add_argument("--case", dest="case_name")
    parser.add_argument("--project")
    parser.add_argument("--project-dir")
    parser.add_argument("--app")
    parser.add_argument("--task-name")
    args = parser.parse_args(argv)
    if args.cloud_test or args.poll_task:
        if args.retry or args.merge is not None or args.check:
            parser.error("云测试独立命令不能和 --retry、--merge 或 --check 一起使用")
        forwarded = ["--config", args.config]
        if args.cloud_test:
            forwarded.append("--cloud-test")
        if args.poll_task:
            forwarded.extend(("--poll-task", args.poll_task))
        for name, value in (("--case", args.case_name), ("--project", args.project),
                            ("--project-dir", args.project_dir), ("--app", args.app),
                            ("--task-name", args.task_name)):
            if value:
                forwarded.extend((name, value))
        return cloudtest_main(forwarded)
    if args.merge is not None:
        if args.check or args.retry or args.case_name:
            parser.error("--merge 不能和 --check、--retry 或 --case 一起使用")
        config = load_autorun_config(args.config)
        merged = merge_overview(args.merge or config["execution"]["outputRoot"])
        print(f"[merge] 已合并 {merged['batchCount']} 个批次 → {merged['overviewPath']}")
        return 0
    if args.case_name and not args.retry:
        parser.error("--case 只能和 --retry 或 --cloud-test 一起使用")
    if args.check and args.retry:
        parser.error("--check 不能和 --retry 一起使用")
    if any((args.project, args.project_dir, args.app, args.task_name)):
        parser.error("--project/--project-dir/--app/--task-name 只能和 --cloud-test 一起使用")
    try:
        result = asyncio.run(run_autorun(args.config, args.retry or "", args.case_name or "", args.check))
        if result.get("overviewPath"):
            print(f"批次报告：{result['overviewPath']}")
        return result["exitCode"]
    except KeyboardInterrupt:
        print("Autorun 已中断", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"Autorun 运行失败：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

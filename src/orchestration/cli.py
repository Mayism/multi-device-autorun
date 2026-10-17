"""Python Autorun command line entry point."""

import argparse
import asyncio
from pathlib import Path
import sys

from pyautorun.orchestration.app import run_autorun
from pyautorun.cloud.cloudtest_cli import main as cloudtest_main
from pyautorun.orchestration.config import load_autorun_config
from pyautorun.orchestration.preflight import check_environment
from pyautorun.reporting.l1_report import collect_l1_report_targets, write_l1_reports
from pyautorun.orchestration.batch_state import read_json
from pyautorun.reporting.reports import merge_overview


def main(argv=None):
    parser = argparse.ArgumentParser(description="Autorun Python 运行入口")
    parser.add_argument("--config", "-c", default="./config/autorun.config.json")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--merge", nargs="?", const="")
    parser.add_argument("--l1", "--l1-report", nargs="?", const="", dest="l1_report")
    parser.add_argument("--cloud-test", action="store_true")
    parser.add_argument("--poll-task")
    parser.add_argument("--case", dest="case_name")
    parser.add_argument("--project")
    parser.add_argument("--project-dir")
    parser.add_argument("--app")
    parser.add_argument("--task-name")
    args = parser.parse_args(argv)
    if args.cloud_test or args.poll_task:
        if args.merge is not None or args.check or args.l1_report is not None:
            parser.error("云测试独立命令不能和 --merge、--l1 或 --check 一起使用")
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
    if args.l1_report is not None:
        if args.merge is not None or args.check or args.case_name:
            parser.error("--l1 不能和 --check、--case 或 --merge 一起使用")
        config = load_autorun_config(args.config)
        run_root, targets = collect_l1_report_targets(args.l1_report, config["execution"]["outputRoot"])
        summaries = [read_json(Path(target["targetRoot"]) / "summary.json") for target in targets]
        run_id = str(next((item.get("batchId") for item in summaries if item and item.get("batchId")),
                          Path(run_root).name))
        model_source = next((item for item in summaries
                             if item and item.get("providerId") and item.get("modelId")), {})
        try:
            l1 = write_l1_reports(run_root, run_id,
                                  {"providerId": model_source.get("providerId")
                                   or config["execution"].get("providerId", ""),
                                   "modelId": model_source.get("modelId")
                                   or config["execution"].get("model", "")},
                                  targets)
        except Exception as error:
            print(f"[l1] {error}", file=sys.stderr)
            return 1
        print(f"[l1] L1 评分报告已生成: {l1['indexPagePath']}")
        return 0
    if args.merge is not None:
        if args.check or args.case_name:
            parser.error("--merge 不能和 --check 或 --case 一起使用")
        config = load_autorun_config(args.config)
        merged = merge_overview(args.merge or config["execution"]["outputRoot"])
        print(f"[merge] 已合并 {merged['batchCount']} 个批次 → {merged['overviewPath']}")
        return 0
    if args.case_name:
        parser.error("--case 只能和 --cloud-test 一起使用")
    if any((args.project, args.project_dir, args.app, args.task_name)):
        parser.error("--project/--project-dir/--app/--task-name 只能和 --cloud-test 一起使用")
    try:
        result = asyncio.run(run_autorun(args.config, args.check))
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

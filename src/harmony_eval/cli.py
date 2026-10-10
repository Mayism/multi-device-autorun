"""harmony-eval run <task.yaml>."""

import argparse
import asyncio
import sys

from pyautorun.harmony_eval.task import load_harmony_task
from pyautorun.orchestration.app import run_autorun


def main(argv=None):
    """Run the HarmonyBot section of a task YAML through the Autorun pipeline."""
    parser = argparse.ArgumentParser(prog="harmony-eval")
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="Run a HarmonyBot task YAML")
    run.add_argument("task_yaml")
    run.add_argument("--check", action="store_true", help="Check the configured runtime before evaluation")
    args = parser.parse_args(argv)
    try:
        config, rounds = load_harmony_task(args.task_yaml)
        if args.check:
            result = asyncio.run(run_autorun(config, check=True))
            return result["exitCode"]
        exit_code = 0
        for index in range(rounds):
            print(f"[harmony-eval] round {index + 1}/{rounds}", flush=True)
            result = asyncio.run(run_autorun(config))
            if result.get("overviewPath"):
                print(f"[harmony-eval] report: {result['overviewPath']}", flush=True)
            exit_code = max(exit_code, result["exitCode"])
        if (config.get("harmonyEval") or {}).get("withoutEnable"):
            print("[harmony-eval] without_enable 基线尚未执行：该字段需要指定关闭 Agent 后的替代执行方式。",
                  file=sys.stderr)
        return exit_code
    except KeyboardInterrupt:
        print("harmony-eval 已中断", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"harmony-eval 运行失败：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

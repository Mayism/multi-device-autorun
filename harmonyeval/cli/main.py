"""harmony-eval command line entry points."""
import argparse
import asyncio
import sys

from harmonyeval.evaluator.preflight import check_task
from harmonyeval.evaluator.runner import run_task
from harmonyeval.evaluator.replay import replay
from harmonyeval.report.io import load_report
from harmonyeval.config import load_task
from harmonyeval.report.comparison import compare_reports
from harmonyeval.utils.encoding import configure_console, console_print, print_json


def main(argv=None):
    configure_console()
    parser = argparse.ArgumentParser(prog='harmonyeval', description='可扩展 HarmonyOS 任务评测')
    commands = parser.add_subparsers(dest='command', required=True)
    run = commands.add_parser('run', help='运行 task.yaml')
    run.add_argument('task')
    run.add_argument('--check', action='store_true', help='仅检查任务、依赖和实际能力装载')
    plan = commands.add_parser('plan', help='检查并展示执行计划')
    plan.add_argument('task')
    for name in ('verify', 'rescore'):
        command = commands.add_parser(name, help='使用已有执行结果复评或重新评分')
        command.add_argument('task')
        command.add_argument('--run', required=True)
    compare = commands.add_parser('compare', help='对齐两次运行的样本与评分')
    compare.add_argument('left')
    compare.add_argument('right')
    compare.add_argument('--output', required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == 'compare':
            _, left = load_report(args.left)
            _, right = load_report(args.right)
            console_print(compare_reports(left, right, args.output))
            return 0
        task = load_task(args.task)
        if args.command == 'plan' or (args.command == 'run' and args.check):
            result = check_task(task)
            print_json(result, indent=2)
            return 0 if result['ready'] else 1
        if args.command in ('verify', 'rescore'):
            console_print(replay(task, args.run, verify=args.command == 'verify'))
            return 0
        result = asyncio.run(run_task(task))
        console_print(f"评测报告：{result['reportPath']}")
        return result['exitCode']
    except KeyboardInterrupt:
        console_print('Harmony Eval 已中断', file=sys.stderr)
        return 130
    except Exception as error:
        console_print(f'Harmony Eval 运行失败：{error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

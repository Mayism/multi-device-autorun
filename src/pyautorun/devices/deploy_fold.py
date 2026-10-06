"""Standalone FoldTrigger deployment command."""

import argparse

from pyautorun.devices.ohostest_fold import deploy_fold_trigger


def main(argv=None):
    parser = argparse.ArgumentParser(description="Deploy FoldTrigger.ets")
    parser.add_argument("--project", required=True)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--module", default="entry")
    args = parser.parse_args(argv)
    path = deploy_fold_trigger(args.project, args.module, args.port)
    print(f"FoldTrigger.ets 已部署到: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Rebuild local case archives from an existing batch summary."""

import argparse
from pathlib import Path

from pyautorun.orchestration.batch_state import read_json
from pyautorun.reporting.archive_cases import archive_cases


def main(argv=None):
    parser = argparse.ArgumentParser(description="Archive Autorun batch results locally")
    parser.add_argument("batch_root")
    args = parser.parse_args(argv)
    root = Path(args.batch_root).resolve()
    summary = read_json(root / "summary.json")
    if not isinstance(summary, dict) or not isinstance(summary.get("results"), list):
        parser.error(f"批次 summary.json 不存在或缺少用例: {root}")
    print(f"已打包 {len(archive_cases(root, summary, print))} 个用例")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

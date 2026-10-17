"""Regenerate batch HTML and local ZIP artifacts from saved results."""

import argparse
from pathlib import Path

from pyautorun.orchestration.batch_state import read_json
from pyautorun.reporting.reports import write_batch_report


def main(argv=None):
    parser = argparse.ArgumentParser(description="Regenerate an Autorun batch report")
    parser.add_argument("batch_root")
    args = parser.parse_args(argv)
    root = Path(args.batch_root).resolve()
    summary = read_json(root / "summary.json")
    if not summary:
        parser.error(f"批次 summary.json 不存在: {root}")
    paths = write_batch_report(root, summary, on_log=print)
    print(paths["htmlOverviewPath"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

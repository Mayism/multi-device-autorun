"""Archive and optionally upload saved batch failures."""

import argparse
from pathlib import Path

from pyautorun.orchestration.batch_state import read_json
from pyautorun.orchestration.config import load_autorun_config
from pyautorun.reporting.upload import archive_and_upload


def main(argv=None):
    parser = argparse.ArgumentParser(description="Archive/upload Autorun batch results")
    parser.add_argument("batch_root")
    parser.add_argument("--config", required=True, help="Path to an explicit legacy JSON config")
    args = parser.parse_args(argv)
    root = Path(args.batch_root).resolve()
    summary = read_json(root / "summary.json")
    report = read_json(root / "report.json")
    if not summary or not report:
        parser.error(f"批次 summary.json/report.json 不存在: {root}")
    config = load_autorun_config(args.config)
    archive_and_upload(root, summary, report, config.get("upload"), print)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

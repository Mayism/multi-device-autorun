"""JSON stdin/stdout bridge for the Python whitebox numeric scoring core."""

import json
import argparse
from pathlib import Path
import sys

from .whitebox_score_result import compute_score_computation


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input")
    parser.add_argument("--output")
    args = parser.parse_args()
    payload = json.loads(Path(args.input).read_text(encoding="utf-8")) if args.input else json.load(sys.stdin)
    official = {"OFFICIAL-LINTER:" + item["ruleId"]: item
                for item in payload["officialProfiles"]}
    result = compute_score_computation(payload["input"], payload["ruleProfiles"], official)
    rendered = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    if args.output:
        Path(args.output).write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)


if __name__ == "__main__":
    main()

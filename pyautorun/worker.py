"""JSON-in worker used by the current Node orchestration layer."""

import json
import os
import sys
import traceback


def main() -> None:
    if sys.version_info < (3, 9):
        raise RuntimeError("Autorun requires Python 3.9 or newer")
    if len(sys.argv) != 2:
        raise ValueError("expected one worker action")
    payload = json.load(sys.stdin)
    action = sys.argv[1]
    if action == "zip":
        from .archive import create_zip
        sys.stdout.buffer.write(create_zip(payload))
    elif action == "batch-report":
        from .batch_report import build_batch_report
        sys.stdout.write(json.dumps(build_batch_report(payload), ensure_ascii=False))
    elif action == "comparison-report":
        from .comparison_report import build_comparison_report
        sys.stdout.write(json.dumps(build_comparison_report(payload), ensure_ascii=False))
    elif action == "cloudtest-config":
        from .cloudtest import load_config
        sys.stdout.write(json.dumps(load_config(payload), ensure_ascii=False))
    elif action == "cloudtest-rank-devices":
        from .cloudtest import rank_devices
        sys.stdout.write(json.dumps(rank_devices(payload.get("devices")), ensure_ascii=False))
    elif action == "cloudtest-final-status":
        from .cloudtest import final_status
        sys.stdout.write(json.dumps(final_status(payload.get("taskGroup")), ensure_ascii=False))
    elif action == "cloudtest-summary":
        from .cloudtest import summarize_report
        sys.stdout.write(json.dumps(summarize_report(payload.get("report")), ensure_ascii=False))
    elif action == "ohostest-config":
        from .ohostest import normalize_config
        sys.stdout.write(json.dumps(normalize_config(payload), ensure_ascii=False))
    elif action == "ohostest-result":
        from .ohostest import classify_result
        sys.stdout.write(json.dumps(classify_result(payload), ensure_ascii=False))
    elif action == "whitebox-config":
        from .whitebox import normalize_config
        sys.stdout.write(json.dumps(normalize_config(payload), ensure_ascii=False))
    elif action == "whitebox-bind-runtime":
        from .whitebox import bind_runtime
        sys.stdout.write(json.dumps(bind_runtime(payload), ensure_ascii=False))
    elif action == "whitebox-resolve-judge":
        from .whitebox import resolve_judge
        sys.stdout.write(json.dumps(resolve_judge(payload), ensure_ascii=False))
    else:
        raise ValueError(f"unknown worker action: {action}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        if os.environ.get("AUTORUN_PYTHON_DEBUG"):
            traceback.print_exc()
        else:
            print(f"{type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)

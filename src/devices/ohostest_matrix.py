"""Standalone Python ohosTest matrix command."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import time

from pyautorun.orchestration.case_run import write_json
from pyautorun.devices.ohostest_execution import CommandLog, run_execution
from pyautorun.devices.ohostest_project import load_execution_config


def run_matrix(project, machine, out, devices=None, test_class="", skip_build=False,
               keep_emulators=False, executor=None):
    started = time.monotonic()
    started_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    output = Path(out).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    log = CommandLog(output.parent / "commands.jsonl", executor)
    try:
        metadata = {"platform": "native", "testCaseTimeoutMs": 15000, "rnBuild": None}
        config = load_execution_config(project, machine, metadata)
        if test_class:
            config["testClass"] = test_class
        selected = list(dict.fromkeys(devices or [item["id"] for item in config["devices"]]))
        unknown = set(selected) - {item["id"] for item in config["devices"]}
        if unknown:
            raise ValueError("unknown devices: " + ", ".join(sorted(unknown)))
        selection = {"devices": selected, "deviceSuiteOverrides": {}, "runAllTests": True}
        result = run_execution(config, selection, output.parent, log, skip_build, keep_emulators)
        result["schemaVersion"] = "ohostest-matrix-v1"
    except Exception as error:
        log.record("error", message=str(error))
        result = {"schemaVersion": "ohostest-matrix-v1", "project": str(Path(project).resolve()),
                  "status": "failed", "startedAt": started_at,
                  "finishedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                  "durationMs": round((time.monotonic() - started) * 1000),
                  "build": {"status": "blocked", "appHap": "", "testHap": "",
                            "blockedReason": str(error)}, "devices": [], "diagnostics": [str(error)]}
    result["artifacts"] = {"commandLog": "commands.jsonl", "summary": "summary.md"}
    write_json(output, result)
    lines = ["# ohosTest Matrix", "", f"Status: {result['status']}", ""]
    for device in result["devices"]:
        lines.append(f"- {device['id']}: {device['status']}")
    for diagnostic in result["diagnostics"]:
        lines.append(f"- {diagnostic}")
    (output.parent / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description="Python ohosTest matrix runner")
    parser.add_argument("--project", required=True)
    parser.add_argument("--machine-config", default="config/machine.json")
    parser.add_argument("--out")
    parser.add_argument("--device", action="append")
    parser.add_argument("--test-class", default="")
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--keep-emulators", action="store_true")
    args = parser.parse_args(argv)
    project = Path(args.project).resolve()
    output = args.out or str(project / ".ohostest-runs" / datetime.now().strftime("%Y%m%d%H%M%S") / "result.json")
    machine = json.loads(Path(args.machine_config).read_text(encoding="utf-8"))
    result = run_matrix(project, machine, output, args.device, args.test_class,
                        args.skip_build, args.keep_emulators)
    print(json.dumps({"status": result["status"], "out": str(Path(output).resolve())}, ensure_ascii=False))
    return 0 if result["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

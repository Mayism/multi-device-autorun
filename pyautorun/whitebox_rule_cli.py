"""JSON file bridge for Python deterministic whitebox rule evaluators."""

import argparse
import json
from pathlib import Path

from .whitebox_rule_text import evaluate_project_structure_rule, evaluate_text_rule
from .whitebox_rule_case_constraint import evaluate_case_constraint_rule
from .whitebox_rule_result import assemble_rule_engine_result
from .whitebox_rule_evidence import collect_rule_evidence


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--mode", choices=("evaluate", "assemble", "evidence"), default="evaluate")
    args = parser.parse_args()
    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    if args.mode == "evidence":
        results = collect_rule_evidence(payload["caseInput"])
    elif args.mode == "assemble":
        results = assemble_rule_engine_result(payload)
    else:
        results = []
        for rule in payload["rules"]:
            mode = rule["detector"]["mode"]
            if mode == "regex":
                results.append(evaluate_text_rule(rule, payload["evidence"]))
            elif mode == "project_structure":
                results.append(evaluate_project_structure_rule(rule, payload["evidence"]))
            elif mode == "case_constraint_precheck":
                results.append(evaluate_case_constraint_rule(rule, payload["evidence"]))
            else:
                raise ValueError(f"Python rule evaluator does not support mode: {mode}")
    Path(args.output).write_text(json.dumps(results, ensure_ascii=False, separators=(",", ":")),
                                 encoding="utf-8")


if __name__ == "__main__":
    main()

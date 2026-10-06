"""Standalone Python whitebox rule engine.

ArkAnalyzer facts, when enabled, are supplied by the isolated Node sidecar.
"""

from pathlib import Path

from .whitebox_arkfacts import collect_ark_facts
from .whitebox_rule_arkts import evaluate_arkts_static_rule
from .whitebox_rule_arkui import build_index as build_arkui_index, evaluate_arkui_static_rule
from .whitebox_rule_arkui_extra import evaluate_arkui_extra_rule
from .whitebox_rule_case_constraint import evaluate_case_constraint_rule
from .whitebox_rule_evidence import collect_rule_evidence
from .whitebox_rule_registry import (DEFAULT_PACK_IDS, enabled_rule_packs, load_rule_packs,
                                     registered_rules)
from .whitebox_rule_result import assemble_rule_engine_result
from .whitebox_rule_text import evaluate_project_structure_rule, evaluate_text_rule


EVALUATORS = {"regex": evaluate_text_rule,
              "project_structure": evaluate_project_structure_rule,
              "case_constraint_precheck": evaluate_case_constraint_rule,
              "arkts_static": evaluate_arkts_static_rule,
              "arkui_extra": evaluate_arkui_extra_rule}


def evaluate_rules(rules, evidence):
    arkui_index = build_arkui_index(evidence) if any(
        rule.get("detector", {}).get("mode") == "arkui_static" for rule in rules) else None
    results = []
    for rule in rules:
        detector = rule["detector"]
        mode = detector.get("mode") if detector["kind"] == "static" else None
        if mode == "arkui_static":
            results.append(evaluate_arkui_static_rule(rule, evidence, arkui_index))
        elif mode in EVALUATORS:
            results.append(EVALUATORS[mode](rule, evidence))
        else:
            results.append({"rule_id": rule["rule_id"], "rule_source": rule["rule_source"],
                            "result": "未接入判定器",
                            "conclusion": rule["summary"] + " 当前版本未接入静态判定器，需要 Agent 辅助判定。",
                            "matchedFiles": []})
    return results


def run_rule_engine(case_input, task_type=None, runtime_rules=(), enabled_pack_ids=None,
                    repo_root=None, environ=None):
    del task_type
    root = Path(repo_root) if repo_root else Path(__file__).resolve().parent.parent
    evidence = collect_rule_evidence(case_input)
    facts = collect_ark_facts(case_input["generatedProjectPath"], evidence.get("caseDir"), root, environ)
    if facts is not None:
        evidence["arkFacts"] = facts
    packs = load_rule_packs(root / "src" / "whitebox" / "references" / "rules")
    enabled = enabled_rule_packs(packs, enabled_pack_ids if enabled_pack_ids is not None else DEFAULT_PACK_IDS)
    rules = registered_rules(packs, [pack["packId"] for pack in enabled], runtime_rules)
    evaluated = evaluate_rules(rules, evidence)
    return assemble_rule_engine_result({"registeredRules": rules, "evaluatedRules": evaluated,
                                        "runtimeRules": list(runtime_rules), "enabledRulePacks": enabled,
                                        "evidence": evidence})

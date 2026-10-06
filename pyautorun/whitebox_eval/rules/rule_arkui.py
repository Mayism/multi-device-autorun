"""ArkUI static rule dispatcher with optional retained ArkAnalyzer facts."""

from pyautorun.whitebox_eval.rules.arkui_ast import index_from_ark_facts
from pyautorun.whitebox_eval.rules.arkui_scanner import build_arkui_scan_index
from pyautorun.whitebox_eval.rules.arkui_specs import TEXT_CHECKS
from pyautorun.whitebox_eval.rules.rule_arkui_components import evaluate_component_rule
from pyautorun.whitebox_eval.rules.rule_arkui_text import evaluate_text_rule


def build_index(evidence):
    facts = evidence.get("arkFacts")
    if facts and facts.get("components"):
        return index_from_ark_facts(facts)
    files = evidence.get("allWorkspaceFiles")
    return build_arkui_scan_index(evidence["workspaceFiles"] if files is None else files)


def evaluate_arkui_static_rule(rule, evidence, index=None):
    if index is None:
        index = build_index(evidence)
    check = rule["detector"]["config"].get("check")
    if check in TEXT_CHECKS:
        return evaluate_text_rule(rule, evidence, index)
    return evaluate_component_rule(rule, evidence, index)

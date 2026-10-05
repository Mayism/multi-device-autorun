"""Differential tests for the complete Python whitebox score fusion."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest

from pyautorun.whitebox_rubric import load_rubric, rubric_snapshot
from pyautorun.whitebox_risk import load_risk_taxonomy
from pyautorun.whitebox_score_core import (compute_numeric_score, load_official_linter_profiles,
                                           load_scoring_profiles)
from pyautorun.whitebox_score_result import compute_score_computation


ROOT = Path(__file__).resolve().parents[2]
WHITEBOX = ROOT / "src" / "whitebox"
MODULE = WHITEBOX / "dist" / "scoring" / "scoreFusion.js"
try:
    import yaml  # noqa: F401
    HAS_YAML = True
except ImportError:
    HAS_YAML = False


def first_difference(actual, expected, path="root"):
    if isinstance(expected, dict) and isinstance(actual, dict):
        for key in expected.keys() | actual.keys():
            if key not in expected or key not in actual:
                return f"{path}.{key}: missing key"
            difference = first_difference(actual[key], expected[key], f"{path}.{key}")
            if difference:
                return difference
        return None
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            return f"{path}: {len(actual)} != {len(expected)}"
        for index, (left, right) in enumerate(zip(actual, expected)):
            difference = first_difference(left, right, f"{path}[{index}]")
            if difference:
                return difference
        return None
    return f"{path}: {actual!r} != {expected!r}" if actual != expected else None


@unittest.skipUnless(HAS_YAML and shutil.which("node") and MODULE.is_file(),
                     "PyYAML or built whitebox scorer unavailable")
class WhiteboxScoreFusionParityTests(unittest.TestCase):
    def test_rule_profiles_match_node_registry(self):
        module = WHITEBOX / "dist" / "rules" / "registry" / "rulePackRegistry.js"
        source = ("import {getRegisteredRulePacks} from " + json.dumps(module.as_uri()) + ";"
                  "process.stdout.write(JSON.stringify(Object.fromEntries(getRegisteredRulePacks()"
                  ".flatMap(p=>p.rules).filter(r=>r.profile).map(r=>[r.rule_id,r.profile]))));")
        node = subprocess.run(["node", "--input-type=module", "-e", source],
                              capture_output=True, text=True, check=True, cwd=WHITEBOX)
        self.assertEqual(load_scoring_profiles(WHITEBOX / "references" / "rules"), json.loads(node.stdout))

    def test_official_linter_profiles_match_node(self):
        module = WHITEBOX / "dist" / "scoring" / "officialLinterRuleProfiles.js"
        source = ("import {officialLinterRuleProfiles} from " + json.dumps(module.as_uri()) + ";"
                  "process.stdout.write(JSON.stringify(officialLinterRuleProfiles));")
        node = subprocess.run(["node", "--input-type=module", "-e", source],
                              capture_output=True, text=True, check=True, cwd=WHITEBOX)
        expected = {"OFFICIAL-LINTER:" + item["ruleId"]: item for item in json.loads(node.stdout)}
        self.assertEqual(load_official_linter_profiles(), expected)

    def test_complete_score_matches_node(self):
        source = ("import {fuseRubricScoreWithRules} from " + json.dumps(MODULE.as_uri()) + ";"
                  "process.stdin.setEncoding('utf8');let s='';for await(const c of process.stdin)s+=c;"
                  "const r=fuseRubricScoreWithRules(JSON.parse(s));"
                  "process.stdout.write(JSON.stringify(r));")
        profiles = load_scoring_profiles(WHITEBOX / "references" / "rules")
        official = load_official_linter_profiles()
        cases = [
            ("full_generation", "skipped", [], 0, None),
            ("continuation", "success", [
                {"rule_id": "ARKTS-MUST-001", "rule_source": "must_rule", "result": "不满足",
                 "conclusion": "entry/src/main.ets:12"},
                {"rule_id": "OFFICIAL-LINTER:@typescript-eslint/no-explicit-any",
                 "rule_source": "official_linter", "result": "不满足", "conclusion": "test",
                 "official_linter_severity": "error"},
                {"rule_id": "CASE-P0", "rule_source": "must_rule", "result": "待人工复核", "conclusion": "test"},
            ], 0, None),
            ("bug_fix", "skipped", [
                {"rule_id": "UNKNOWN", "rule_source": "forbidden_pattern", "result": "不满足", "conclusion": "test"},
            ], 9, {"hardGateTriggered": True, "status": "failed", "scoreCap": 59,
                   "moduleResults": [{"modulePath": "entry", "command": "assembleApp",
                                      "status": "failed", "diagnostics": "compile failed"}],
                   "checkedModules": ["entry"], "buildCheckSource": "agent",
                   "deprecatedApiWarnings": [{"file": "entry/src/main.ets", "line": 3,
                                              "column": 4, "apiName": "oldApi"}]}),
            ("full_generation", "success", [
                {"rule_id": "ARKTS-FORBID-003", "rule_source": "must_rule", "result": "不满足", "conclusion": "test"},
                {"rule_id": "CASE-P0", "rule_source": "must_rule", "result": "不满足", "conclusion": "test"},
                {"rule_id": "OFFICIAL-LINTER:@security/no-unsafe-hash", "rule_source": "official_linter",
                 "result": "待人工复核", "conclusion": "test", "official_linter_severity": "suggestion"},
            ], 0, None),
            ("bug_fix", "success", [
                {"rule_id": "ARKTS-SHOULD-001", "rule_source": "should_rule", "result": "不满足", "conclusion": "test"},
                {"rule_id": "UNKNOWN-2", "rule_source": "must_rule", "result": "待人工复核", "conclusion": "test"},
            ], 0, None),
            ("continuation", "success", [
                {"rule_id": "ARKTS-MUST-001", "rule_source": "must_rule", "result": "不满足", "conclusion": "test"},
            ], 0, None),
        ]
        for case_index, (task_type, status, rules, changed, build_summary) in enumerate(cases):
            with self.subTest(task_type=task_type):
                rubric = load_rubric(task_type, WHITEBOX / "references" / "scoring")
                scoring_result = None
                if status == "success":
                    def selected_band(item):
                        index = -1 if case_index == len(cases) - 1 else case_index % len(item["scoringBands"])
                        return item["scoringBands"][index]["score"]

                    scoring_result = {"item_scores": [
                        {"dimension_name": dim["name"], "item_name": item["name"],
                         "score": selected_band(item), "matched_band_score": selected_band(item),
                         "rationale": "baseline", "evidence_used": ["example"], "confidence": "high"}
                        for dim in rubric["dimensions"] for item in dim["items"]],
                        "risks": [{"risk_code": "LANGUAGE_CONSTRAINT_VIOLATION",
                                   "level": "medium", "title": "原始风险", "description": "test",
                                   "evidence": "entry/src/main.ets:12"}],
                        "strengths": ["可读"], "main_issues": ["需核查"]}
                data = {"taskType": task_type, "rubric": rubric, "rubricSnapshot": rubric_snapshot(rubric),
                        "rubricScoringResult": scoring_result, "rubricAgentRunStatus": status,
                        "ruleAuditResults": rules, "ruleViolations": [],
                        "evidenceSummary": {"workspaceFileCount": 0, "originalFileCount": 0,
                                            "changedFileCount": changed, "changedFiles": [], "hasPatch": False},
                        "caseRuleDefinitions": [{"rule_id": "CASE-P0", "priority": "P0"}],
                        "hvigorBuildCheckSummary": build_summary,
                        "riskTaxonomy": load_risk_taxonomy(WHITEBOX / "references" / "risks" /
                                                          "risk-taxonomy.yaml")}
                bridge_env = {**os.environ, "HMOS_WHITEBOX_PYTHON_SCORE_ENABLE": "true",
                              "HMOS_WHITEBOX_PYTHON_EXECUTABLE": shutil.which("python3"),
                              "PYTHONPATH": str(ROOT) + os.pathsep + os.environ.get("PYTHONPATH", "")}
                node_command = ["node", "--input-type=module", "-e", source]
                node_input = json.dumps(data, ensure_ascii=False)
                legacy_env = {**bridge_env, "HMOS_WHITEBOX_PYTHON_SCORE_ENABLE": "false"}
                legacy = subprocess.run(node_command, input=node_input, text=True,
                                        capture_output=True, cwd=WHITEBOX, env=legacy_env)
                self.assertEqual(legacy.returncode, 0, legacy.stderr)
                expected = json.loads(legacy.stdout)
                actual_full = compute_score_computation(data, profiles, official)
                self.assertIsNone(first_difference(actual_full, expected))
                bridged = subprocess.run(node_command, input=node_input, text=True,
                                         capture_output=True, cwd=WHITEBOX, env=bridge_env)
                self.assertEqual(bridged.returncode, 0, bridged.stderr)
                self.assertEqual(json.loads(bridged.stdout), json.loads(legacy.stdout))
                actual = compute_numeric_score(data, profiles, official)
                for key, expected_value in (("scoreFusionDetails", expected["scoreFusionDetails"]),
                                            ("dimensionScores", expected["dimensionScores"]),
                                            ("submetricDetails", expected["submetricDetails"]),
                                            ("preCapScore", expected["overallConclusion"]["pre_cap_score"]),
                                            ("totalScore", expected["totalScore"])):
                    self.assertIsNone(first_difference(actual[key], expected_value, key))


if __name__ == "__main__":
    unittest.main()

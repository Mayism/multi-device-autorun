"""Python whitebox agent output coverage and retry behavior."""

import json
import unittest

from pyautorun.whitebox_eval.runtime.agents import parse_rubric_scoring, parse_rule_assessment, run_agent


class WhiteboxAgentProtocolTests(unittest.TestCase):
    def test_rule_coverage_and_order(self):
        candidates = [{"rule_id": "R1"}, {"rule_id": "R2"}]
        result = {"summary": {"assistant_scope": "patch", "overall_confidence": "medium"},
                  "rule_assessments": [
                      {"rule_id": rule, "decision": "pass", "confidence": "high",
                       "reason": "符合规则", "evidence_used": [], "needs_human_review": "false"}
                      for rule in ("R2", "R1")]} 
        parsed = parse_rule_assessment(result, candidates)
        self.assertEqual([item["rule_id"] for item in parsed["rule_assessments"]], ["R1", "R2"])
        self.assertFalse(parsed["rule_assessments"][0]["needs_human_review"])
        with self.assertRaisesRegex(ValueError, "missing=R1"):
            parse_rule_assessment({**result, "rule_assessments": result["rule_assessments"][:1]}, candidates)

    def test_rubric_score_snaps_and_requires_trace(self):
        snapshot = {"dimension_summaries": [{"name": "D", "item_summaries": [
            {"name": "I", "weight": 10, "scoring_bands": [{"score": 10}, {"score": 5}]}]}]}
        result = {"summary": {"overall_assessment": "好", "overall_confidence": "medium"},
                  "item_scores": [{"dimension_name": "D", "item_name": "I", "score": "9",
                                   "rationale": "证据", "evidence_used": [], "confidence": "high",
                                   "review_required": "false"}],
                  "hard_gate_candidates": [], "risks": [], "strengths": [], "main_issues": []}
        taxonomy = {"entries": []}
        parsed = parse_rubric_scoring(result, snapshot, taxonomy)
        self.assertEqual(parsed["item_scores"][0]["score"], 10)
        result["item_scores"][0]["score"] = 5
        with self.assertRaisesRegex(ValueError, "invalid_deduction_trace"):
            parse_rubric_scoring(result, snapshot, taxonomy)

    def test_agent_retries_invalid_json_in_new_request(self):
        calls = []
        def runner(_runtime, request):
            calls.append(request)
            raw = "bad" if len(calls) == 1 else json.dumps({
                "explicitConstraints": [], "contextualConstraints": [], "implicitConstraints": [],
                "classificationHints": [], "crossDeviceAdaptation": {
                    "applicability": "not_involved", "confidence": "high", "reasons": ["无适配需求"]}})
            return {"rawText": raw, "rawEvents": ""}
        outcome = run_agent("understanding", {"caseId": "case"}, "/tmp/sandbox", {}, runner)
        self.assertEqual(outcome["outcome"], "success")
        self.assertEqual(len(calls), 2)
        self.assertIn("上次错误", calls[1]["prompt"])


if __name__ == "__main__":
    unittest.main()

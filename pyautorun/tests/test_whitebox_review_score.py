"""Verify score and gate changes caused by human risk review."""

import unittest

from pyautorun.whitebox_review_score import apply_human_review_recalculation


class ReviewScoreTests(unittest.TestCase):
    def test_correcting_risk_level_reverses_rule_delta_and_gate(self):
        result = {"overall_conclusion": {"total_score": 59, "hard_gate_triggered": True},
            "score_policy": {"risk_level_weights": {"high": 1, "medium": .6, "low": .3, "none": 0}},
            "risks": [{"id": 1, "level": "high", "score_effect": {
                "type": "risk_level_rule_impact", "rule_id": "R1", "original_level": "high",
                "hard_gate_active_levels": ["high"], "hard_gate_ids": ["G1"], "gate_caps": {"G1": 59},
                "impacts": [{"dimension_name": "D", "item_name": "I", "original_score_delta": -20}]}}],
            "dimension_results": [{"dimension_name": "D", "score": 80,
                "item_results": [{"item_name": "I", "score": 80,
                    "agent_evaluation": {"base_score": 100},
                    "rule_impacts": [{"rule_id": "R1", "score_delta": -20}],
                    "score_fusion": {"rule_delta": -20, "final_score": 80}}]}]}
        revised, summary = apply_human_review_recalculation(result,
            {"riskReviews": [{"riskId": 1, "agree": False, "correctedLevel": "medium", "reason": "低估"}]},
            "2026-01-01T00:00:00Z")
        self.assertEqual(revised["dimension_results"][0]["item_results"][0]["score"], 88)
        self.assertEqual(revised["overall_conclusion"]["total_score"], 88)
        self.assertFalse(revised["overall_conclusion"]["hard_gate_triggered"])
        self.assertTrue(summary["scoreRecalculationApplied"])
        self.assertEqual(result["risks"][0]["level"], "high")


if __name__ == "__main__":
    unittest.main()

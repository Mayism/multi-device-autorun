"""Verify review persistence and Python gap-analysis scheduling."""

import json
from pathlib import Path
import tempfile
import unittest

from pyautorun.whitebox_eval.service.api import WhiteboxApiService
from pyautorun.whitebox_eval.service.human_review import submit_human_review
from pyautorun.whitebox_eval.service.review_dataset import read_dataset


class HumanReviewTests(unittest.TestCase):
    def test_manual_rating_gap_writes_artifact_and_dataset(self):
        def gap(_case_dir, _manual, _result):
            return {"primaryConclusion": "insufficient_evidence", "confidence": "low",
                    "reasonSummary": "缺少证据", "humanRatingReview": {"needsImprovement": False,
                    "reason": "证据不足"}, "scoringSystemReview": {"needsImprovement": False,
                    "reason": "证据不足"}, "evidence": ["outputs/result.json"],
                    "recommendedActions": ["补充证据"]}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            case = root / "case"
            (case / "outputs").mkdir(parents=True)
            (case / "outputs" / "result.json").write_text(json.dumps({
                "overall_conclusion": {"total_score": 85, "hard_gate_triggered": False},
                "basic_info": {"case_name": "demo"}, "risks": [], "human_review_items": []}))
            service = WhiteboxApiService(root, review_root=root / "review", gap_analyzer=gap,
                                         recover=False)
            service.store.upsert_remote(7, "completed", caseDir=str(case), testCaseName="demo",
                                        testCaseId=10)
            status, response = submit_human_review(service, 7, {"manualLevel": "L1",
                                                                "overallComment": "人工认为很差"})
            service.close()
            self.assertEqual(status, 200)
            self.assertTrue(response["summary"]["gapQualified"])
            self.assertTrue((case / "human-rating" / "analysis.json").is_file())
            self.assertEqual(read_dataset(root / "review", "human_rating_gap_analysis")["items"][0][
                "primaryConclusion"], "insufficient_evidence")


if __name__ == "__main__":
    unittest.main()

"""Validate Python dashboard review dataset updates."""

import tempfile
import unittest

from pyautorun.whitebox_eval.service.review_dataset import append_dataset, query_dataset, update_manual_status


class ReviewDatasetTests(unittest.TestCase):
    def test_human_gap_status_update(self):
        with tempfile.TemporaryDirectory() as root:
            append_dataset(root, "human_rating_gap_analysis", {"taskId": 4, "reviewedAt": "2026-01-01T00:00:00Z",
                "manualRating": "L3", "primaryConclusion": "scoring_gap"})
            result = update_manual_status(root, "human_rating_gap_analysis", [4, 9], "analyzed")
            self.assertEqual(result["updated"], 1)
            self.assertEqual(result["missing"], [{"taskId": 9}])
            dataset = query_dataset(root, "human_rating_gap_analysis", {"manualAnalysisStatus": "analyzed"})
            self.assertEqual(dataset["total"], 1)
            self.assertEqual(dataset["items"][0]["caseName"], "Task 4")

    def test_only_disagreed_risk_can_be_marked_analyzed(self):
        with tempfile.TemporaryDirectory() as root:
            for task_id, agreed in ((1, True), (2, False)):
                append_dataset(root, "risk_review_calibration", {"taskId": task_id, "riskId": 1,
                    "humanReview": {"agree": agreed}})
            items = [{"taskId": task_id, "riskId": 1} for task_id in (1, 2, 3)]
            result = update_manual_status(root, "risk_review_calibration", items, "analyzed")
            self.assertEqual(result["updated"], 1)
            self.assertEqual(result["skipped"], [{"taskId": 1, "riskId": 1, "reason": "not_disagreed"}])
            self.assertEqual(result["missing"], [{"taskId": 3, "riskId": 1}])
            dataset = query_dataset(root, "risk_review_calibration", {"agreement": "disagreed"})
            self.assertEqual(dataset["items"][0]["manualAnalysisStatus"], "analyzed")


if __name__ == "__main__":
    unittest.main()

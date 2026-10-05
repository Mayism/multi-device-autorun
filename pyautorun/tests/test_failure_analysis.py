"""UITest failure evidence and model-output validation."""

import unittest

from pyautorun.failure_analysis import collect_uitest_failures, normalize_analyses


class FailureAnalysisTests(unittest.TestCase):
    def test_collects_failed_tests_with_stable_ids(self):
        runner = {"runs": {"swe": {"devices": [{"id": "phone", "suiteResults": [{"suiteClass": "DemoTest",
                  "testCases": [{"name": "works", "status": "passed", "statusCode": 0},
                                {"name": "fails", "status": "failed", "statusCode": -2,
                                 "message": "not found", "stack": "at test (entry/test.ets:3:1)"}]}]}]}}}
        failures = collect_uitest_failures(runner)
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["suite"], "DemoTest")
        self.assertEqual(len(failures[0]["failureId"]), 16)
        normalized = normalize_analyses({"analyses": [{"failureId": failures[0]["failureId"],
           "category": "interaction_failure", "uxReason": "按钮未出现", "confidence": "high"}]}, failures)
        self.assertEqual(normalized[0]["uxReason"], "按钮未出现")
        self.assertEqual(normalized[0]["category"], "interaction_failure")


if __name__ == "__main__":
    unittest.main()

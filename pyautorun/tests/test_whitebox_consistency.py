"""Check consistency patch merging and SQLite compatibility."""

import tempfile
import unittest

from pyautorun.whitebox_consistency import merge_consistency_patch
from pyautorun.whitebox_service_store import WhiteboxServiceStore


class ConsistencyTests(unittest.TestCase):
    def test_patch_replaces_run_by_task_and_appends_unique_history(self):
        original = {"id": "job", "sequence": 1,
                    "runs": [{"taskId": 3, "runIndex": 0, "status": "running"}],
                    "analysisHistory": [{"round": 1, "capturedAt": "now"}]}
        patched = merge_consistency_patch(original, {"runs": [
            {"taskId": 3, "runIndex": 0, "status": "completed"},
            {"taskId": 4, "runIndex": 1, "status": "failed"}],
            "analysisHistory": [{"round": 1, "capturedAt": "now"},
                                {"round": 2, "capturedAt": "later"}]})
        self.assertEqual(len(patched["runs"]), 2)
        self.assertEqual(patched["runs"][0]["status"], "completed")
        self.assertEqual(len(patched["analysisHistory"]), 2)
        with tempfile.TemporaryDirectory() as temp:
            store = WhiteboxServiceStore(temp)
            store.upsert_consistency(patched)
            self.assertEqual(store.list_consistency()[0]["runs"][1]["taskId"], 4)


if __name__ == "__main__":
    unittest.main()

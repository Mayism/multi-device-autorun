"""Check cross-device dashboard projection from Python whitebox artifacts."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from pyautorun.whitebox_cross_device import cases_page, related_tasks, rule_violations_page


@unittest.skipUnless(importlib.util.find_spec("yaml"), "PyYAML unavailable")
class CrossDeviceTests(unittest.TestCase):
    def test_involved_task_and_violated_cross_device_rule(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "intermediate").mkdir()
            (root / "outputs").mkdir()
            (root / "intermediate" / "task-understanding.json").write_text(json.dumps({
                "crossDeviceAdaptation": {"applicability": "involved", "reasons": ["双设备"]}}))
            (root / "outputs" / "result.json").write_text(json.dumps({
                "official_linter_summary": {"configuredRuleSets": [
                    "plugin:@cross-device-app-dev/recommended"], "runStatus": "success"},
                "bound_rule_packs": [{"pack_id": "cross-device-adaptation", "display_name": "跨设备"}],
                "rule_audit_results": [{"rule_id": "OM-CONFIG-MUST-01", "result": "不满足",
                                        "rule_source": "must_rule", "rule_summary": "跨设备规则",
                                        "conclusion": "不合规"}]}))
            base = {"taskId": 5, "name": "双设备", "status": "completed", "statusCategory": "completed",
                    "taskType": "continuation", "score": 80, "hardGateTriggered": False,
                    "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
                    "resultAvailable": True, "risks": []}
            tasks = related_tasks([{"taskId": 5, "caseDir": str(root)}], [base])
            self.assertEqual(len(tasks), 1)
            self.assertEqual(tasks[0]["reasons"], ["双设备"])
            self.assertEqual(cases_page(tasks, {})["total"], 1)
            self.assertEqual(rule_violations_page(tasks, {})["total"], 1)


if __name__ == "__main__":
    unittest.main()

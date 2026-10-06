"""Python result assembly follows the existing v2 report contract."""

import json
from pathlib import Path
import shutil
import subprocess
import unittest

from pyautorun.whitebox_report_result import build_result_json


ROOT = Path(__file__).resolve().parents[2]
WHITEBOX = ROOT / "src" / "whitebox"
TOOLS = WHITEBOX / "dist" / "workflow" / "nodes" / "reportGeneration" / "tools.js"


@unittest.skipUnless(shutil.which("node") and TOOLS.is_file(), "built report builder unavailable")
class WhiteboxReportResultTests(unittest.TestCase):
    def test_basic_result(self):
        detail = {"dimension_name": "D", "item_name": "I",
                  "agent_evaluation": {"base_score": 10, "matched_band_score": 10,
                                       "matched_criteria": "full", "logic": "通过", "evidence_used": [],
                                       "confidence": "high"}, "rule_impacts": [],
                  "score_fusion": {"base_score": 10, "rule_delta": 0, "final_score": 10,
                                   "fusion_logic": "无扣分"}}
        state = {"taskType": "continuation", "caseInput": {"caseId": "sample",
                "generatedProjectPath": "/tmp/generated"},
                "taskUnderstanding": {"classificationHints": ["continuation"]},
                "rubricSnapshot": {"dimension_summaries": [{"name": "D", "weight": 10,
                                   "intent": "test", "item_summaries": [{"name": "I", "weight": 10,
                                   "scoring_bands": [{"score": 10, "criteria": "full"}]}]}]},
                "scoreComputation": {"overallConclusion": {"total_score": 10, "summary": "通过"},
                     "totalScore": 10, "hardGateTriggered": False,
                     "scoreFusionDetails": [detail], "dimensionScores": [{"dimension_name": "D",
                         "score": 10, "max_score": 10, "comment": "正常"}],
                     "submetricDetails": [{"dimension_name": "D", "metric_name": "I", "score": 10,
                         "confidence": "high", "review_required": False}],
                     "risks": [], "strengths": [], "mainIssues": [], "humanReviewItems": [],
                     "finalRecommendation": []},
                "deterministicRuleResults": [], "caseRuleDefinitions": [],
                "enabledRulePacks": [{"pack_id": "arkts-language", "display_name": "ArkTS", "version": "v1"}]}
        actual = build_result_json(state, "2026-01-01T00:00:00.000Z")
        source = ("import {buildReportResultJson} from " + json.dumps(TOOLS.as_uri()) + ";"
                  "process.stdout.write(JSON.stringify(buildReportResultJson(JSON.parse(process.argv[1]))));")
        node = subprocess.run(["node", "--input-type=module", "-e", source, json.dumps(state)],
                              cwd=WHITEBOX, check=True, text=True, capture_output=True)
        expected = json.loads(node.stdout)
        expected["report_meta"]["generated_at"] = "2026-01-01T00:00:00.000Z"
        self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()

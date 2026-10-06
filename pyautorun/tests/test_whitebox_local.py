"""The Python local whitebox entry can produce a schema-valid result without Node."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pyautorun.whitebox_eval.runtime.local import run_local_whitebox
from pyautorun.whitebox_eval.scoring.review_score import apply_human_review_recalculation
from pyautorun.whitebox_eval.scoring.schema import validate_whitebox_result


ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(importlib.util.find_spec("yaml") and importlib.util.find_spec("jsonschema"),
                     "whitebox Python extras unavailable")
class LocalWhiteboxTests(unittest.TestCase):
    def test_result_without_node_or_external_linter(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            original = root / "original"
            generated = root / "generated"
            original.mkdir()
            generated.mkdir()
            (original / "Page.ets").write_text("Text('old')\n", encoding="utf-8")
            (generated / "Page.ets").write_text("Text('new')\n", encoding="utf-8")
            prompt = root / "prompt.md"
            prompt.write_text("修改页面文案", encoding="utf-8")
            manifest = {"schemaVersion": "whitebox-input-v1", "caseId": "sample",
                        "taskType": "continuation", "promptPath": str(prompt),
                        "originalProjectPath": str(original), "generatedProjectPath": str(generated),
                        "outputDir": str(root / "out")}
            def fake_agent(kind, payload, _sandbox, _runtime, _runner, **kwargs):
                if kind == "understanding":
                    answer = {"explicitConstraints": ["修改文案"], "contextualConstraints": [],
                              "implicitConstraints": [], "classificationHints": ["continuation"],
                              "crossDeviceAdaptation": {"applicability": "not_involved", "confidence": "high",
                                                        "reasons": ["未涉及多设备"]}}
                elif kind == "rubric":
                    items = [{"dimension_name": dimension["name"], "item_name": item["name"],
                              "score": item["scoring_bands"][0]["score"], "max_score": item["weight"],
                              "matched_band_score": item["scoring_bands"][0]["score"],
                              "rationale": "无需扣分", "evidence_used": [], "confidence": "high",
                              "review_required": False}
                             for dimension in kwargs["snapshot"]["dimension_summaries"]
                             for item in dimension["item_summaries"]]
                    answer = {"summary": {"overall_assessment": "完成", "overall_confidence": "high"},
                              "item_scores": items, "hard_gate_candidates": [], "risks": [],
                              "strengths": [], "main_issues": []}
                else:
                    answer = {"summary": {"assistant_scope": "patch", "overall_confidence": "medium"},
                              "rule_assessments": [{"rule_id": candidate["rule_id"],
                                  "decision": "uncertain", "confidence": "low", "reason": "需要人工复核",
                                  "evidence_used": [], "needs_human_review": True}
                                  for candidate in payload["assisted_rule_candidates"]]}
                return {"outcome": "success", "final_answer": answer,
                        "final_answer_raw_text": json.dumps(answer), "raw_events": ""}
            with patch("pyautorun.whitebox_eval.runtime.local.run_agent", fake_agent):
                result = run_local_whitebox(manifest, repo_root=ROOT, runtime={},
                                            environ={"HMOS_CODE_LINTER_ENABLED": "false",
                                                     "HMOS_HVIGOR_BUILD_CHECK_ENABLED": "false"})
            self.assertEqual(result["status"], "completed")
            self.assertTrue(Path(result["resultPath"]).is_file())
            self.assertTrue(Path(result["reportPath"]).is_file())
            result_json = json.loads(Path(result["resultPath"]).read_text(encoding="utf-8"))
            revised, _ = apply_human_review_recalculation(result_json,
                {"itemReviews": [], "riskReviews": []}, "2026-10-06T00:00:00Z")
            validate_whitebox_result(revised,
                ROOT / "pyautorun" / "whitebox_eval" / "resources" / "references" / "scoring" /
                "report_result_schema.json")


if __name__ == "__main__":
    unittest.main()

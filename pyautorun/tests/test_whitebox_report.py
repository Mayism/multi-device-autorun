"""Differential checks against the retained whitebox report renderer."""

import json
from pathlib import Path
import shutil
import subprocess
import unittest

from pyautorun.whitebox_report import render_whitebox_html


ROOT = Path(__file__).resolve().parents[2]
RENDERER = ROOT / "src" / "whitebox" / "dist" / "report" / "renderHtml.js"


@unittest.skipUnless(shutil.which("node") and RENDERER.is_file(), "built whitebox renderer unavailable")
class WhiteboxReportParityTests(unittest.TestCase):
    def test_empty_and_populated_reports_match_node(self):
        fixtures = [{}, {"overall_conclusion": {"total_score": 1.0}},
                    {"basic_info": {"target_description": "A&B <工程>",
                                        "task_type": "continuation", "evaluation_mode": "auto_precheck"},
                         "overall_conclusion": {"total_score": 84.5, "hard_gate_triggered": True,
                                                "summary": "发现 1 个问题"},
                         "dimension_results": [{"dimension_name": "ArkUI", "score": 8, "max_score": 10,
                                                "comment": "能运行"}],
                         "rule_audit_results": [{"rule_id": "R1", "result": "不满足",
                                                 "rule_summary": "条件", "conclusion": "缺少 '声明'"}],
                         "risks": [{"level": "high", "title": "崩溃", "description": "空值"}],
                         "main_issues": ["组件未渲染"]}]
        source = ("import {renderWhiteboxHtml} from " + json.dumps(RENDERER.as_uri()) + ";"
                  "let data='';for await (const chunk of process.stdin)data+=chunk;"
                  "process.stdout.write(renderWhiteboxHtml(JSON.parse(data)));" )
        for fixture in fixtures:
            with self.subTest(fixture=bool(fixture)):
                result = subprocess.run(["node", "--input-type=module", "-e", source],
                                        input=json.dumps(fixture, ensure_ascii=False),
                                        text=True, capture_output=True, check=True)
                self.assertEqual(render_whitebox_html(fixture), result.stdout)


if __name__ == "__main__":
    unittest.main()

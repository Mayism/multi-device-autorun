"""Python rule merge matches Node fallback and Agent decision semantics."""

import json
from pathlib import Path
import shutil
import subprocess
import unittest

from pyautorun.whitebox_rule_merge import merge_rule_results


ROOT = Path(__file__).resolve().parents[2]
WHITEBOX = ROOT / "src" / "whitebox"
MODULE = WHITEBOX / "dist" / "agents" / "normalization" / "ruleAssistance.js"


@unittest.skipUnless(shutil.which("node") and MODULE.is_file(), "built rule merger unavailable")
class WhiteboxRuleMergeTests(unittest.TestCase):
    def test_merges(self):
        candidates = [{"rule_id": "R1", "rule_summary": "禁止 any", "rule_name": "禁止 any",
                       "rule_source": "must_rule", "is_case_rule": False,
                       "why_uncertain": "需要判断", "evidence_files": ["entry/Page.ets"]},
                      {"rule_id": "R2", "rule_summary": "检查 Navigation", "rule_name": "Navigation",
                       "rule_source": "should_rule", "is_case_rule": True,
                       "why_uncertain": "静态层无法确认", "evidence_files": []}]
        final = {"summary": {"assistant_scope": "patch", "overall_confidence": "medium"},
                 "rule_assessments": [{"rule_id": "R1", "decision": "uncertain", "confidence": "low",
                                       "reason": "补丁未发现该规则相关改动", "evidence_used": [],
                                       "needs_human_review": True},
                                      {"rule_id": "R2", "decision": "pass", "confidence": "high",
                                       "reason": "Navigation 结构正常", "evidence_used": [],
                                       "needs_human_review": False}]}
        source = ("import {mergeRuleAuditResults} from " + json.dumps(MODULE.as_uri()) + ";"
                  "process.stdout.write(JSON.stringify(mergeRuleAuditResults(JSON.parse(process.argv[1]))));")
        for answer in (None, final):
            with self.subTest(answer=answer is not None):
                data = {"deterministicRuleResults": [], "assistedRuleCandidates": candidates}
                if answer:
                    data["agentFinalAnswer"] = answer
                node = subprocess.run(["node", "--input-type=module", "-e", source, json.dumps(data)],
                                      cwd=WHITEBOX, check=True, text=True, capture_output=True)
                actual = merge_rule_results([], candidates, answer)
                self.assertEqual(actual, json.loads(node.stdout))


if __name__ == "__main__":
    unittest.main()

"""Case constraint YAML mapping matches the original implementation."""

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from pyautorun.whitebox_case_constraints import load_case_constraints


ROOT = Path(__file__).resolve().parents[2]
WHITEBOX = ROOT / "src" / "whitebox"
LOADER = WHITEBOX / "dist" / "rules" / "case-constraints" / "loader.js"


@unittest.skipUnless(shutil.which("node") and LOADER.is_file(), "built constraint loader unavailable")
class CaseConstraintsParityTests(unittest.TestCase):
    def test_yaml_mapping(self):
        try:
            import yaml  # noqa: F401
        except ImportError:
            self.skipTest("PyYAML unavailable")
        content = """constraints:
  - id: CASE-001
    name: 保留路由
    description: " 保留原始路由 "
    priority: P0
    kit: [ArkUI, Navigation]
    rules:
      - target: entry/src/main/ets/pages
        ast: [{kind: component, name: Navigation}]
        llm: 检查路由
      - target: entry/src/main/ets/components
        ast: [{kind: import, name: Router}]
        llm: 检查组件
  - id: CASE-002
    name: 不新增全局状态
    priority: P1
    rules:
      - target: entry/src/main/ets
"""
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "constraints.yaml"
            path.write_text(content, encoding="utf-8")
            case = {"caseId": "sample", "expectedConstraintsPath": str(path)}
            actual = load_case_constraints(case)
            source = ("import {loadCaseConstraintRules} from " + json.dumps(LOADER.as_uri()) + ";"
                      "process.stdout.write(JSON.stringify(await loadCaseConstraintRules(JSON.parse(process.argv[1]))));")
            node = subprocess.run(["node", "--input-type=module", "-e", source, json.dumps(case)],
                                  cwd=WHITEBOX, check=True, text=True, capture_output=True)
            self.assertEqual(actual, json.loads(node.stdout))


if __name__ == "__main__":
    unittest.main()

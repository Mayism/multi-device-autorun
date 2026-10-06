"""Compare Python ArkUI project/text checks with the current evaluator."""

import json
from pathlib import Path
import shutil
import subprocess
import unittest

from pyautorun.whitebox_arkui_scanner import build_arkui_scan_index
from pyautorun.whitebox_arkui_specs import TEXT_CHECKS
from pyautorun.whitebox_rule_arkui_text import evaluate_text_rule


ROOT = Path(__file__).resolve().parents[2]
WHITEBOX = ROOT / "src" / "whitebox"
REGISTRY = WHITEBOX / "dist" / "rules" / "registry" / "rulePackRegistry.js"
DISPATCH = WHITEBOX / "dist" / "rules" / "core" / "evaluationDispatcher.js"


@unittest.skipUnless(shutil.which("node") and REGISTRY.is_file() and DISPATCH.is_file(),
                     "built ArkUI evaluator unavailable")
class ArkuiTextRuleParityTests(unittest.TestCase):
    def test_all_text_rules(self):
        source = ("import {getRegisteredRulePacks} from " + json.dumps(REGISTRY.as_uri()) + ";"
                  "import {evaluateRegisteredRule} from " + json.dumps(DISPATCH.as_uri()) + ";"
                  "process.stdin.setEncoding('utf8');let s='';for await(const c of process.stdin)s+=c;"
                  "const evidence=JSON.parse(s);"
                  "const rules=getRegisteredRulePacks().flatMap(p=>p.rules).filter(r=>r.detector.mode==='arkui_static'"
                  "&&new Set(" + json.dumps(sorted(TEXT_CHECKS)) + ").has(r.detector.config.check));"
                  "process.stdout.write(JSON.stringify({rules,results:rules.map(r=>evaluateRegisteredRule(r,evidence))}));")
        ets = """@Entry @Component struct Page {
  build() {
    Column() {
      GridRow({breakpoints:{value:['320vp','600vp','840vp','1440vp']}}) { GridCol() { Text('a') } }
      FolderStack({upperItems:['header']}) { Text('header').id('header') }.width('100%').height('100%')
      Web({src:'index.html'}).width(500).height('100%')
      Image('a').aspectRatio({sm:1,md:1.5})
    }
  }
}
"""
        fixtures = [
            {"workspaceFiles": [], "allWorkspaceFiles": [], "changedFiles": []},
            {"workspaceFiles": [
                {"relativePath": "entry/src/main.ets", "content": ets},
                {"relativePath": "entry/src/main/module.json5", "content": "{module:{type:'entry',deviceTypes:['phone','tablet']}}"},
                {"relativePath": "entry/src/main/resources/rawfile/web/style.css", "content": "@media (min-width: 900px) { .x { width: 50%; } }"},
            ], "changedFiles": []},
        ]
        fixtures[1]["allWorkspaceFiles"] = fixtures[1]["workspaceFiles"]
        for fixture, evidence in enumerate(fixtures):
            with self.subTest(fixture=fixture):
                node = subprocess.run(["node", "--input-type=module", "-e", source],
                                      input=json.dumps(evidence), text=True, capture_output=True,
                                      check=True, cwd=WHITEBOX)
                expected = json.loads(node.stdout)
                self.assertTrue(expected["rules"])
                self.assertTrue({rule["detector"]["config"]["check"] for rule in expected["rules"]}
                                <= TEXT_CHECKS)
                index = build_arkui_scan_index(evidence["allWorkspaceFiles"])
                actual = [evaluate_text_rule(rule, evidence, index) for rule in expected["rules"]]
                for rule, got, want in zip(expected["rules"], actual, expected["results"]):
                    self.assertEqual(got, want, rule["rule_id"])


if __name__ == "__main__":
    unittest.main()

"""Differential checks for ArkUI supplemental rules."""

import json
from pathlib import Path
import shutil
import subprocess
import unittest

from pyautorun.whitebox_rule_arkui_extra import evaluate_arkui_extra_rule


ROOT = Path(__file__).resolve().parents[2]
WHITEBOX = ROOT / "src" / "whitebox"
REGISTRY = WHITEBOX / "dist" / "rules" / "registry" / "rulePackRegistry.js"
DISPATCH = WHITEBOX / "dist" / "rules" / "core" / "evaluationDispatcher.js"


@unittest.skipUnless(shutil.which("node") and REGISTRY.is_file() and DISPATCH.is_file(),
                     "built ArkUI extra evaluator unavailable")
class ArkuiExtraRuleParityTests(unittest.TestCase):
    def test_route_and_bind_sheet(self):
        source = ("import {getRegisteredRulePacks} from " + json.dumps(REGISTRY.as_uri()) + ";"
                  "import {evaluateRegisteredRule} from " + json.dumps(DISPATCH.as_uri()) + ";"
                  "process.stdin.setEncoding('utf8');let s='';for await(const c of process.stdin)s+=c;"
                  "const evidence=JSON.parse(s);"
                  "const rules=getRegisteredRulePacks().flatMap(p=>p.rules).filter(r=>r.detector.mode==='arkui_extra');"
                  "process.stdout.write(JSON.stringify({rules,results:rules.map(r=>evaluateRegisteredRule(r,evidence))}));")
        files = [
            {"relativePath": "entry/src/main/module.json5", "content": "{routerMap: '$profile:route_map'}"},
            {"relativePath": "entry/src/main/resources/base/profile/route_map.json",
             "content": json.dumps({"routerMap": [{"pageSourceFile": "src/main/ets/pages/Home"}]})},
            {"relativePath": "entry/src/main/ets/pages/Home.ets",
             "content": "@Entry struct Home { build() { NavDestination() .bindSheet($$a)\n.bindSheet($$b) }}"},
        ]
        fixtures = [
            {"workspaceFiles": [], "allWorkspaceFiles": [], "changedFiles": []},
            {"workspaceFiles": files, "allWorkspaceFiles": files, "changedFiles": []},
            {"workspaceFiles": files, "allWorkspaceFiles": files,
             "changedFiles": ["entry/src/main/ets/pages/Home.ets"]},
            {"workspaceFiles": [files[2]], "allWorkspaceFiles": files,
             "changedFiles": ["entry/src/main/resources/base/profile/route_map.json"]},
            {"workspaceFiles": [files[2]], "allWorkspaceFiles": [files[0], files[2]],
             "changedFiles": ["entry/src/main/module.json5"]},
        ]
        for index, evidence in enumerate(fixtures):
            with self.subTest(fixture=index):
                node = subprocess.run(["node", "--input-type=module", "-e", source],
                                      input=json.dumps(evidence), text=True, capture_output=True,
                                      check=True, cwd=WHITEBOX)
                expected = json.loads(node.stdout)
                self.assertEqual(len(expected["rules"]), 2)
                actual = [evaluate_arkui_extra_rule(rule, evidence) for rule in expected["rules"]]
                self.assertEqual(actual, expected["results"])


if __name__ == "__main__":
    unittest.main()

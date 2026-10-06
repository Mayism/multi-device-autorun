"""Differential tests for Python ArkTS static rules."""

import json
from pathlib import Path
import shutil
import subprocess
import unittest

from pyautorun.whitebox_arkts_scanner import scan_arkts_light_facts
from pyautorun.whitebox_arkts_ast import index_from_ark_facts
from pyautorun.whitebox_rule_arkts import evaluate_arkts_static_rule


ROOT = Path(__file__).resolve().parents[2]
WHITEBOX = ROOT / "src" / "whitebox"
REGISTRY = WHITEBOX / "dist" / "rules" / "registry" / "rulePackRegistry.js"
DISPATCH = WHITEBOX / "dist" / "rules" / "core" / "evaluationDispatcher.js"
AST = WHITEBOX / "dist" / "rules" / "evaluators" / "arkts" / "astFacts.js"


@unittest.skipUnless(shutil.which("node") and REGISTRY.is_file() and DISPATCH.is_file(),
                     "built ArkTS evaluator unavailable")
class ArktsRuleParityTests(unittest.TestCase):
    def test_ark_analyzer_fact_adapter(self):
        facts = {"files": [{"relativePath": "entry/src/main.ets", "hasViewTree": True}],
                 "declarations": [{"id": "a", "filePath": "entry/src/main.ets", "kind": "class",
                                   "name": "Widget", "line": 2, "extendsNames": ["Base"],
                                   "implementsNames": ["IWidget"],
                                   "fields": [{"name": "ready", "line": 3, "typeText": "boolean",
                                               "initializer": {"kind": "literal", "value": True}}]},
                                  {"id": "b", "filePath": "entry/src/main.ets", "kind": "enum",
                                   "name": "State", "line": 7, "extendsNames": [], "implementsNames": [],
                                   "fields": [], "enumMembers": [{"name": "READY", "line": 8,
                                                                   "initializer": {"kind": "literal", "value": 1}}]}],
                 "methods": [{"filePath": "entry/src/main.ets", "name": "doWork", "line": 4,
                              "parameters": [{"name": "value", "typeText": "boolean", "optional": False}],
                              "assignments": [{"target": "ready", "line": 5,
                                               "value": {"kind": "literal", "value": False}}]}],
                 "viewTrees": [], "components": [], "diagnostics": []}
        source = ("import {buildArktsLightScanIndexFromArkFacts} from " + json.dumps(AST.as_uri()) + ";"
                  "process.stdin.setEncoding('utf8');let s='';for await(const c of process.stdin)s+=c;"
                  "const value=buildArktsLightScanIndexFromArkFacts(JSON.parse(s));"
                  "process.stdout.write(JSON.stringify(value,(key,item)=>item instanceof Set?[...item].sort():item));")
        node = subprocess.run(["node", "--input-type=module", "-e", source],
                              input=json.dumps(facts), text=True, capture_output=True, check=True, cwd=WHITEBOX)
        actual = index_from_ark_facts(facts)
        actual = {key: sorted(value) if isinstance(value, set) else value for key, value in actual.items()}
        self.assertEqual(actual, json.loads(node.stdout))

    def test_registered_rules_on_source_and_patch(self):
        source = ("import {getRegisteredRulePacks} from " + json.dumps(REGISTRY.as_uri()) + ";"
                  "import {evaluateRegisteredRule} from " + json.dumps(DISPATCH.as_uri()) + ";"
                  "process.stdin.setEncoding('utf8');let s='';for await(const c of process.stdin)s+=c;"
                  "const evidence=JSON.parse(s);"
                  "const rules=getRegisteredRulePacks().flatMap(p=>p.rules).filter(r=>r.detector.mode==='arkts_static');"
                  "process.stdout.write(JSON.stringify({rules,results:rules.map(r=>evaluateRegisteredRule(r,evidence))}));")
        content = """class bad_class extends IThing implements Widget {
  value: boolean = true;
  public Ready: number = 1;
  DoWork(first: boolean) {
    let item: Widget = {};
    item = new Widget();
  }
}
interface IThing extends Widget {}
class Widget {}
enum Mixed { good = 1, BAD = 'bad' }
namespace Mixed {}
function BadFunc(bad: boolean) {}
const badConstant: number = 2;
let neverChanged = Widget;
type ESObjectAlias = ESObject;
"""
        for patch in (None, [1, 2, 5, 10, 11, 13, 14, 15]):
            with self.subTest(patch=patch):
                file = {"relativePath": "entry/src/main/ets/Index.ets", "content": content}
                if patch is not None:
                    file["patchLineNumbers"] = patch
                evidence = {"workspaceFiles": [file]}
                node = subprocess.run(["node", "--input-type=module", "-e", source],
                                      input=json.dumps(evidence), text=True, capture_output=True,
                                      check=True, cwd=WHITEBOX)
                expected = json.loads(node.stdout)
                self.assertEqual(len(expected["rules"]), 14)
                index = scan_arkts_light_facts(evidence)
                actual = [evaluate_arkts_static_rule(rule, evidence, index) for rule in expected["rules"]]
                self.assertEqual(actual, expected["results"])


if __name__ == "__main__":
    unittest.main()

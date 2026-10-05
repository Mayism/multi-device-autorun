"""Differential checks for Python text and project-structure rule evaluators."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from pyautorun.whitebox_rule_text import evaluate_project_structure_rule, evaluate_text_rule
from pyautorun.whitebox_rule_case_constraint import evaluate_case_constraint_rule


ROOT = Path(__file__).resolve().parents[2]
WHITEBOX = ROOT / "src" / "whitebox"
REGISTRY = WHITEBOX / "dist" / "rules" / "registry" / "rulePackRegistry.js"
DISPATCH = WHITEBOX / "dist" / "rules" / "core" / "evaluationDispatcher.js"
ENGINE = WHITEBOX / "dist" / "rules" / "core" / "ruleEngine.js"


@unittest.skipUnless(shutil.which("node") and REGISTRY.is_file() and DISPATCH.is_file(),
                     "built whitebox rule evaluator unavailable")
class WhiteboxTextRuleParityTests(unittest.TestCase):
    def test_registered_regex_rules_match_node(self):
        source = ("import {getRegisteredRulePacks} from " + json.dumps(REGISTRY.as_uri()) + ";"
                  "import {evaluateRegisteredRule} from " + json.dumps(DISPATCH.as_uri()) + ";"
                  "process.stdin.setEncoding('utf8');let s='';for await(const c of process.stdin)s+=c;"
                  "const evidence=JSON.parse(s);"
                  "const rules=getRegisteredRulePacks().flatMap(p=>p.rules).filter(r=>r.detector.mode==='regex');"
                  "process.stdout.write(JSON.stringify({rules,results:rules.map(r=>evaluateRegisteredRule(r,evidence))}));")
        corpus = """// var globalThis @ts-ignore
const literal = "var eval( #private";
var count = 0;
const item: any = 1;
globalThis.console.log(item);
const value = Symbol('x');
if (count = 1) { throw 'error'; }
try { count++; } finally { return; }
let ratio = .5;
delete item.property;
const large = new Array(2048);
function* generator() {}
"""
        fixtures = [
            {"workspaceFiles": [{"relativePath": "entry/src/main.ets", "content": corpus},
                                {"relativePath": "entry/src/other.ts", "content": "var unused = 1;"}]},
            {"workspaceFiles": [{"relativePath": "entry/src/main.ets", "content": corpus,
                                 "patchLineNumbers": [1, 2, 5, 8]}]},
            {"workspaceFiles": [{"relativePath": "entry/src/main.ets",
                                 "content": "// var globalThis\nconst text = 'eval( var';\n"}]},
            {"workspaceFiles": []},
        ]
        for index, evidence in enumerate(fixtures):
            with self.subTest(fixture=index):
                node = subprocess.run(["node", "--input-type=module", "-e", source],
                                      input=json.dumps(evidence, ensure_ascii=False), text=True,
                                      capture_output=True, check=True, cwd=WHITEBOX)
                payload = json.loads(node.stdout)
                self.assertEqual(len(payload["rules"]), 34)
                if index == 0:
                    self.assertGreaterEqual(sum(item["result"] == "不满足" for item in payload["results"]), 10)
                actual = [evaluate_text_rule(rule, evidence) for rule in payload["rules"]]
                self.assertEqual(actual, payload["results"])

    def test_project_structure_rule(self):
        rule = {"rule_id": "PROJECT-001", "rule_source": "must_rule", "summary": "需要清单。",
                "detector": {"kind": "static", "mode": "project_structure",
                             "config": {"requiredPaths": ["entry/module.json5", "entry/src/main.ets"]}}}
        evidence = {"workspaceFiles": [{"relativePath": "entry/src/main.ets", "content": ""}]}
        actual = evaluate_project_structure_rule(rule, evidence)
        self.assertEqual(actual["result"], "不满足")
        self.assertEqual(actual["matchedFiles"], ["entry/module.json5"])

    def test_case_constraint_precheck_matches_node(self):
        rule = {"rule_id": "CASE-PRECHECK", "rule_source": "must_rule", "summary": "约束检查",
                "detector": {"kind": "static", "mode": "case_constraint_precheck", "config": {
                    "targetPatterns": ["entry/src/**/*.ets"],
                    "astSignals": [{"type": "CallExpression", "callee": "setResponse", "argument": "answer"},
                                   {"type": "Property", "name": "missing"}],
                    "kit": ["ArkUI: Button display aspectRatio", "media: MediaPlayer", "@kit.Sensor: SensorService"]}}}
        source = ("import {evaluateRegisteredRule} from " + json.dumps(DISPATCH.as_uri()) + ";"
                  "process.stdin.setEncoding('utf8');let s='';for await(const c of process.stdin)s+=c;"
                  "const {rule,evidence}=JSON.parse(s);"
                  "process.stdout.write(JSON.stringify(evaluateRegisteredRule(rule,evidence)));")
        fixtures = [
            {"workspaceFiles": []},
            {"workspaceFiles": [{"relativePath": "entry/src/main/pages/Index.ets", "content":
                                 "import {MediaPlayer} from '@kit.MediaKit';\nButton().display()\n"
                                 "setResponse(answer); SensorService.run();\n",
                                 "patchLineNumbers": [2]}]},
            {"workspaceFiles": [{"relativePath": "entry/src/main/pages/Index.ets", "content":
                                 "const text = 'MediaPlayer SensorService display';\n"
                                 "setResponse(answer);\n",
                                 "patchLineNumbers": [1]}]},
        ]
        for index, evidence in enumerate(fixtures):
            with self.subTest(fixture=index):
                node = subprocess.run(["node", "--input-type=module", "-e", source],
                                      input=json.dumps({"rule": rule, "evidence": evidence}, ensure_ascii=False),
                                      text=True, capture_output=True, check=True, cwd=WHITEBOX)
                self.assertEqual(evaluate_case_constraint_rule(rule, evidence), json.loads(node.stdout))

    def test_registered_case_constraints_match_node(self):
        source = ("import {getRegisteredRulePacks} from " + json.dumps(REGISTRY.as_uri()) + ";"
                  "import {evaluateRegisteredRule} from " + json.dumps(DISPATCH.as_uri()) + ";"
                  "process.stdin.setEncoding('utf8');let s='';for await(const c of process.stdin)s+=c;"
                  "const evidence=JSON.parse(s);"
                  "const rules=getRegisteredRulePacks().flatMap(p=>p.rules)"
                  ".filter(r=>r.detector.mode==='case_constraint_precheck');"
                  "process.stdout.write(JSON.stringify({rules,results:rules.map(r=>evaluateRegisteredRule(r,evidence))}));")
        evidence = {"workspaceFiles": [{"relativePath": "entry/src/main/ets/pages/Index.ets",
                                       "content": "import { SensorService } from '@kit.SensorServiceKit';\n"
                                       "Button().display().aspectRatio(1);\n"
                                       "MediaPlayer.start();\n",
                                       "patchLineNumbers": [2]}]}
        node = subprocess.run(["node", "--input-type=module", "-e", source],
                              input=json.dumps(evidence), text=True, capture_output=True,
                              check=True, cwd=WHITEBOX)
        payload = json.loads(node.stdout)
        self.assertEqual(len(payload["rules"]), 12)
        self.assertEqual([evaluate_case_constraint_rule(rule, evidence) for rule in payload["rules"]],
                         payload["results"])

    def test_full_rule_engine_with_python_text_rules_matches_node(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = root / "original"
            generated = root / "generated"
            for project in (original, generated):
                target = project / "entry" / "src" / "main.ets"
                target.parent.mkdir(parents=True)
                target.write_text("var count: any = 0;\nglobalThis.console.log(count);\n", encoding="utf-8")
            runtime_rule = {"pack_id": "case", "rule_id": "CASE-PROJECT", "rule_source": "must_rule",
                            "summary": "需要文件", "rule_name": "检查路径", "priority": "P0",
                            "is_case_rule": True,
                            "detector": {"kind": "static", "mode": "project_structure",
                                         "config": {"requiredPaths": ["entry/missing.txt"]}},
                            "fallback": {"policy": "agent_assisted"},
                            "decisionCriteria": {"pass": ["存在"], "fail": ["缺失"]}}
            constraint_rule = {"pack_id": "case", "rule_id": "CASE-CONSTRAINT",
                               "rule_source": "must_rule", "summary": "检查调用", "rule_name": "调用约束",
                               "priority": "P0", "is_case_rule": True,
                               "detector": {"kind": "static", "mode": "case_constraint_precheck",
                                            "config": {"targetPatterns": ["entry/src/**/*.ets"],
                                                       "astSignals": [{"type": "CallExpression", "name": "console"}],
                                                       "kit": ["ArkUI: Button"]}},
                               "fallback": {"policy": "agent_assisted"}}
            source = ("import {runRuleEngine} from " + json.dumps(ENGINE.as_uri()) + ";"
                      "const result=await runRuleEngine({referenceRoot:process.cwd()+'/references/scoring',"
                      "caseInput:{caseId:'case',originalProjectPath:process.argv[1],"
                      "generatedProjectPath:process.argv[2]},taskType:'continuation',"
                      "runtimeRules:" + json.dumps([runtime_rule, constraint_rule], ensure_ascii=False) + "});"
                      "process.stdout.write(JSON.stringify(result));")
            base_env = {**os.environ, "PYTHONPATH": str(ROOT) + os.pathsep + os.environ.get("PYTHONPATH", ""),
                        "HMOS_WHITEBOX_PYTHON_EXECUTABLE": shutil.which("python3"),
                        "HMOS_ARKANALYZER_ENABLE": "false"}
            outputs = []
            for enabled in ("false", "true"):
                result = subprocess.run(["node", "--input-type=module", "-e", source,
                                         str(original), str(generated)],
                                        capture_output=True, text=True, cwd=WHITEBOX,
                                        env={**base_env, "HMOS_WHITEBOX_PYTHON_RULES_ENABLE": enabled})
                self.assertEqual(result.returncode, 0, result.stderr)
                outputs.append(json.loads(result.stdout))
            self.assertEqual(outputs[1], outputs[0])


if __name__ == "__main__":
    unittest.main()

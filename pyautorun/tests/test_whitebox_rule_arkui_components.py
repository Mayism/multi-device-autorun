"""Compare Python ArkUI component checks with the existing rule evaluator."""

import json
from pathlib import Path
import shutil
import subprocess
import unittest

from pyautorun.whitebox_arkui_scanner import build_arkui_scan_index
from pyautorun.whitebox_arkui_specs import SPEC_BY_CHECK, TEXT_CHECKS
from pyautorun.whitebox_rule_arkui_components import evaluate_component_rule


ROOT = Path(__file__).resolve().parents[2]
WHITEBOX = ROOT / "src" / "whitebox"
REGISTRY = WHITEBOX / "dist" / "rules" / "registry" / "rulePackRegistry.js"
DISPATCH = WHITEBOX / "dist" / "rules" / "core" / "evaluationDispatcher.js"


@unittest.skipUnless(shutil.which("node") and REGISTRY.is_file() and DISPATCH.is_file(),
                     "built ArkUI evaluator unavailable")
class ArkuiComponentRuleParityTests(unittest.TestCase):
    def test_all_component_rules(self):
        source = ("import {getRegisteredRulePacks} from " + json.dumps(REGISTRY.as_uri()) + ";"
                  "import {evaluateRegisteredRule} from " + json.dumps(DISPATCH.as_uri()) + ";"
                  "process.stdin.setEncoding('utf8');let s='';for await(const c of process.stdin)s+=c;"
                  "const evidence=JSON.parse(s);"
                  "const rules=getRegisteredRulePacks().flatMap(p=>p.rules).filter(r=>r.detector.mode==='arkui_static'"
                  "&&!new Set(" + json.dumps(sorted(TEXT_CHECKS)) + ").has(r.detector.config.check));"
                  "process.stdout.write(JSON.stringify({rules,results:rules.map(r=>evaluateRegisteredRule(r,evidence))}));")
        content = """@Entry @Component struct MainPage {
  build() {
    Column() {
      Tabs() { TabContent() {} TabContent() {} }.vertical({sm:false,md:true}).barPosition(this.position)
      GridRow({columns:{sm:4,md:8,lg:12},breakpoints:{value:['320vp','600vp','840vp','1440vp']}}) {
        GridCol({span:{sm:4,md:4}}) { Text('a') }
        GridCol({span:{sm:4,md:4}}) { Text('b') }
      }.gutter(12)
      SideBarContainer({type:SideBarContainerType.Embed}) {}.showSideBar({sm:false,md:true}).sideBarWidth(240)
      List() {}.lanes({sm:1,md:2}).space({sm:4,md:8}).divider({strokeWidth:1})
      WaterFlow() {}.columnsTemplate({sm:'1fr',md:'1fr 1fr'}).layoutMode(WaterFlowLayoutMode.SLIDING_WINDOW)
      Swiper() {}.displayCount({sm:1,md:2}).indicator(false).prevMargin(10)
      Navigation() {}.navBarWidth(200)
      Flex() {}.flexGrow(1).justifyContent(FlexAlign.SpaceEvenly)
      Row() {}.layoutWeight(1).displayPriority(2)
      Blank()
      Scroll() {}.scrollable(ScrollDirection.Horizontal)
    }
  }
}
"""
        fixtures = [
            {"workspaceFiles": [], "allWorkspaceFiles": [], "changedFiles": []},
            {"workspaceFiles": [{"relativePath": "entry/src/main.ets", "content": content}],
             "allWorkspaceFiles": [{"relativePath": "entry/src/main.ets", "content": content}],
             "changedFiles": []},
        ]
        for index, evidence in enumerate(fixtures):
            with self.subTest(fixture=index):
                node = subprocess.run(["node", "--input-type=module", "-e", source],
                                      input=json.dumps(evidence), text=True, capture_output=True,
                                      check=True, cwd=WHITEBOX)
                expected = json.loads(node.stdout)
                self.assertTrue(expected["rules"])
                self.assertTrue({rule["detector"]["config"]["check"] for rule in expected["rules"]}
                                <= set(SPEC_BY_CHECK))
                scan = build_arkui_scan_index(evidence["allWorkspaceFiles"])
                actual = [evaluate_component_rule(rule, evidence, scan) for rule in expected["rules"]]
                self.assertEqual(actual, expected["results"])


if __name__ == "__main__":
    unittest.main()

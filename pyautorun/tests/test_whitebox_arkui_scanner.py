"""Compare Python ArkUI source scanning with the former scanner."""

import json
from pathlib import Path
import shutil
import subprocess
import unittest

from pyautorun.whitebox_arkui_scanner import build_arkui_scan_index
from pyautorun.whitebox_arkui_ast import index_from_ark_facts


ROOT = Path(__file__).resolve().parents[2]
WHITEBOX = ROOT / "src" / "whitebox"
SCANNER = WHITEBOX / "dist" / "rules" / "evaluators" / "arkui" / "staticScanner.js"
AST = WHITEBOX / "dist" / "rules" / "evaluators" / "arkui" / "astFacts.js"


@unittest.skipUnless(shutil.which("node") and SCANNER.is_file(), "built ArkUI scanner unavailable")
class ArkuiScannerParityTests(unittest.TestCase):
    def test_ark_analyzer_component_adapter(self):
        facts = {"components": [
            {"id": "root", "viewTreeId": "v", "name": "GridRow", "kind": "system",
             "filePath": "entry/src/main.ets", "childIds": ["child"], "stateRefs": ["currentBreakpoint"],
             "attributes": [{"name": "breakpoints", "source": "create", "line": 3,
                             "expr": {"kind": "opaque", "reason": "unresolved"}},
                            {"name": "width", "source": "modifier", "line": 4,
                             "expr": {"kind": "literal", "value": "100%"}}]},
            {"id": "child", "viewTreeId": "v", "name": "GridCol", "kind": "system",
             "filePath": "entry/src/main.ets", "parentId": "root", "childIds": [], "stateRefs": [],
             "attributes": [{"name": "span", "source": "constructor", "line": 6,
                             "expr": {"kind": "breakpointValue", "values": {"sm": {"kind": "literal", "value": 12}}}}]},
        ]}
        source = ("import {buildArkuiStaticScanIndexFromArkFacts} from " + json.dumps(AST.as_uri()) + ";"
                  "process.stdin.setEncoding('utf8');let s='';for await(const c of process.stdin)s+=c;"
                  "process.stdout.write(JSON.stringify(buildArkuiStaticScanIndexFromArkFacts(JSON.parse(s))));")
        node = subprocess.run(["node", "--input-type=module", "-e", source],
                              input=json.dumps(facts), text=True, capture_output=True,
                              check=True, cwd=WHITEBOX)
        self.assertEqual(index_from_ark_facts(facts), json.loads(node.stdout))

    def test_component_chains_and_context(self):
        source = ("import {buildArkuiStaticScanIndex} from " + json.dumps(SCANNER.as_uri()) + ";"
                  "process.stdin.setEncoding('utf8');let s='';for await(const c of process.stdin)s+=c;"
                  "process.stdout.write(JSON.stringify(buildArkuiStaticScanIndex(JSON.parse(s))));")
        content = """const WIDTH = 600;
@Component struct Demo {
  build() {
    if (this.currentBreakpoint === 'sm') {
      Column() {
        Text('hello').fontSize(12)
        // Button().width(10)
        Row() { Text('world') }.width('100%')
      }.width(WIDTH).height(20)
    }
  }
}
"""
        files = [{"relativePath": "entry/src/main/ets/pages/Index.ets", "content": content},
                 {"relativePath": "entry/src/main/ets/pages/Other.ets",
                  "content": "static readonly BIG = 100;\nButton('x').bindSheet($$show)"}]
        node = subprocess.run(["node", "--input-type=module", "-e", source],
                              input=json.dumps(files), text=True, capture_output=True,
                              check=True, cwd=WHITEBOX)
        self.assertEqual(build_arkui_scan_index(files), json.loads(node.stdout))


if __name__ == "__main__":
    unittest.main()

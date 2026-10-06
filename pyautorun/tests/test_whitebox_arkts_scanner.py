"""Check ArkTS light source facts against the former scanner."""

import json
from pathlib import Path
import shutil
import subprocess
import unittest

from pyautorun.whitebox_arkts_scanner import scan_arkts_light_facts


ROOT = Path(__file__).resolve().parents[2]
WHITEBOX = ROOT / "src" / "whitebox"
SCANNER = WHITEBOX / "dist" / "rules" / "evaluators" / "arkts" / "lightScanner.js"


@unittest.skipUnless(shutil.which("node") and SCANNER.is_file(), "built ArkTS scanner unavailable")
class ArktsScannerParityTests(unittest.TestCase):
    def test_source_and_patch_facts(self):
        source = ("import {scanArktsLightFacts} from " + json.dumps(SCANNER.as_uri()) + ";"
                  "process.stdin.setEncoding('utf8');let s='';for await(const c of process.stdin)s+=c;"
                  "const value=scanArktsLightFacts(JSON.parse(s));"
                  "process.stdout.write(JSON.stringify(value,(key,item)=>item instanceof Set?[...item].sort():item));")
        content = """class Widget extends Base implements IWidget {
  value: boolean = true;
  private ready: number = 1;
  doWork(first: boolean, second?: string) {
    let item: Widget = {};
    item = new Widget();
  }
}
interface IWidget extends IBase {}
type Alias = Widget;
enum State { READY = 1, WAITING = 'wait' }
namespace State {}
function Run(isReady: boolean) {}
const ANSWER: number = 42;
let thing = Widget;
"""
        for patch in (None, [1, 2, 5, 10, 11, 12, 13]):
            with self.subTest(patch=patch):
                file = {"relativePath": "entry/src/main/ets/Index.ets", "content": content}
                if patch is not None:
                    file["patchLineNumbers"] = patch
                evidence = {"workspaceFiles": [file]}
                node = subprocess.run(["node", "--input-type=module", "-e", source],
                                      input=json.dumps(evidence), text=True, capture_output=True,
                                      check=True, cwd=WHITEBOX)
                actual = scan_arkts_light_facts(evidence)
                actual = {key: sorted(value) if isinstance(value, set) else value for key, value in actual.items()}
                self.assertEqual(actual, json.loads(node.stdout))


if __name__ == "__main__":
    unittest.main()

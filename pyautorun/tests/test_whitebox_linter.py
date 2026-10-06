"""Official Code Linter parsing and patch scoping parity."""

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from pyautorun.whitebox_linter import build_linter_config, map_linter_findings, parse_linter_output


ROOT = Path(__file__).resolve().parents[2]
WHITEBOX = ROOT / "src" / "whitebox"
PARSER = WHITEBOX / "dist" / "rules" / "official-linter" / "parse" / "parser.js"
MAPPER = WHITEBOX / "dist" / "rules" / "official-linter" / "map" / "resultMapper.js"
CONFIG = WHITEBOX / "dist" / "rules" / "official-linter" / "config" / "configWriter.js"


@unittest.skipUnless(shutil.which("node") and PARSER.is_file() and MAPPER.is_file(),
                     "built official linter parser unavailable")
class WhiteboxLinterParityTests(unittest.TestCase):
    def test_config(self):
        source = ("import {buildOfficialCodeLinterConfig} from " + json.dumps(CONFIG.as_uri()) + ";"
                  "process.stdout.write(JSON.stringify(buildOfficialCodeLinterConfig()));")
        node = subprocess.run(["node", "--input-type=module", "-e", source],
                              cwd=WHITEBOX, check=True, text=True, capture_output=True)
        self.assertEqual(build_linter_config(), json.loads(node.stdout))

    def test_json_parse_and_patch_scope(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp) / "workspace"
            workspace.mkdir()
            (workspace / "Page.ets").write_text("\n" * 10, encoding="utf-8")
            stdout = json.dumps([{"filePath": str(workspace / "Page.ets"), "messages": [
                {"ruleId": "@security/no-eval", "message": "Avoid eval", "severity": 2,
                 "line": 3, "column": 4},
                {"ruleId": "@security/no-eval", "message": "Avoid eval", "severity": 2,
                 "line": 8, "column": 4}]}])
            parsed = parse_linter_output(stdout)
            actual = map_linter_findings(parsed["findings"], workspace, True,
                                         ["Page.ets"], {"Page.ets": [3]})
            source = ("import {parseOfficialCodeLinterOutput} from " + json.dumps(PARSER.as_uri()) + ";"
                      "import {mapOfficialCodeLinterFindings} from " + json.dumps(MAPPER.as_uri()) + ";"
                      "const parsed=parseOfficialCodeLinterOutput({stdout:process.argv[1],stderr:''});"
                      "const mapped=mapOfficialCodeLinterFindings({findings:parsed.findings,"
                      "workspaceDir:process.argv[2],hasPatch:true,changedFiles:['Page.ets'],"
                      "changedLineNumbersByFile:{'Page.ets':[3]}});"
                      "process.stdout.write(JSON.stringify({parsed,mapped}));")
            node = subprocess.run(["node", "--input-type=module", "-e", source, stdout, str(workspace)],
                                  cwd=WHITEBOX, check=True, text=True, capture_output=True)
            expected = json.loads(node.stdout)
            self.assertEqual(parsed, expected["parsed"])
            self.assertEqual(actual, expected["mapped"])


if __name__ == "__main__":
    unittest.main()

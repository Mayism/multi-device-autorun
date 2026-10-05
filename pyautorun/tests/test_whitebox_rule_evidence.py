"""Compare Python whitebox file and patch evidence with Node."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from pyautorun.whitebox_rule_evidence import collect_rule_evidence


ROOT = Path(__file__).resolve().parents[2]
WHITEBOX = ROOT / "src" / "whitebox"
MODULE = WHITEBOX / "dist" / "rules" / "evidence" / "collectEvidence.js"


@unittest.skipUnless(shutil.which("node") and MODULE.is_file(), "built evidence collector unavailable")
class WhiteboxRuleEvidenceParityTests(unittest.TestCase):
    def test_file_filters_and_patch_scope_match(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = root / "original"
            generated = root / "run" / "workspace"
            for project in (original, generated):
                files = {"entry/src/main.ets": "var count = 0;\r\nglobalThis.x = 1;\r\n",
                         "entry/src/other.ets": "const other = 1;\n",
                         "entry/src/test/Test.ets": "var shouldIgnore = 1;\n",
                         "entry/src/ohosTest/Test.ets": "var shouldIgnore = 1;\n",
                         "entry/src/BuildProfile.ets": "var shouldIgnore = 1;\n",
                         "entry/src/debug.log": "ignore\n",
                         "entry/src/keep.tmp": "included\n",
                         ".onemulti/cache.txt": "ignore\n"}
                for relative, content in files.items():
                    target = project / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(content.encode("utf-8"))
                (project / ".gitignore").write_text("*.tmp\n", encoding="utf-8")
            patch = root / "run" / "diff" / "patch.diff"
            patch.parent.mkdir(parents=True)
            patch.write_text("""diff --git a/entry/src/main.ets b/entry/src/main.ets
--- a/entry/src/main.ets
+++ b/entry/src/main.ets
@@ -1,1 +1,2 @@
 var count = 0;
+globalThis.x = 1;
diff --git a/entry/src/BuildProfile.ets b/entry/src/BuildProfile.ets
--- a/entry/src/BuildProfile.ets
+++ b/entry/src/BuildProfile.ets
@@ -1,0 +1,1 @@
+var shouldIgnore = 1;
""", encoding="utf-8")
            source = ("import {collectEvidence} from " + json.dumps(MODULE.as_uri()) + ";"
                      "process.stdin.setEncoding('utf8');let s='';for await(const c of process.stdin)s+=c;"
                      "process.stdout.write(JSON.stringify(await collectEvidence(JSON.parse(s))));")
            for patch_path in (None, str(patch)):
                with self.subTest(patch=bool(patch_path)):
                    case_input = {"caseId": "case", "originalProjectPath": str(original),
                                  "generatedProjectPath": str(generated)}
                    if patch_path:
                        case_input["patchPath"] = patch_path
                    env = {**os.environ, "HMOS_ARKANALYZER_ENABLE": "false"}
                    node = subprocess.run(["node", "--input-type=module", "-e", source],
                                          input=json.dumps(case_input), text=True, capture_output=True,
                                          check=True, cwd=WHITEBOX, env=env)
                    self.assertEqual(collect_rule_evidence(case_input), json.loads(node.stdout))


if __name__ == "__main__":
    unittest.main()

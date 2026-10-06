"""The retained ArkAnalyzer sidecar exchanges JSON with Python."""

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SIDECAR_ROOT = ROOT / "src" / "whitebox_eval" / "ark_analyzer"
SIDECAR = SIDECAR_ROOT / "dist" / "rules" / "arkfacts" / "cli.js"


@unittest.skipUnless(shutil.which("node") and SIDECAR.is_file(), "ArkAnalyzer sidecar unavailable")
class ArkFactsSidecarTests(unittest.TestCase):
    def test_fixture_scene(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "input.json"
            target = Path(temp) / "output.json"
            source.write_text(json.dumps({"projectPath": temp,
                                          "fixtureScene": {"projectDirectory": temp, "files": [],
                                                           "viewTrees": []}}), encoding="utf-8")
            subprocess.run(["node", str(SIDECAR), str(source), str(target)],
                           cwd=SIDECAR_ROOT, check=True, capture_output=True)
            facts = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(facts["components"], [])
            self.assertEqual(facts["diagnostics"], [])


if __name__ == "__main__":
    unittest.main()

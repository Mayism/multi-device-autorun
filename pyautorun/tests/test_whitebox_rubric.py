"""Check Python rubric normalization against the current whitebox implementation."""

import json
from pathlib import Path
import shutil
import subprocess
import unittest

from pyautorun.whitebox_rubric import load_rubric, rubric_snapshot


ROOT = Path(__file__).resolve().parents[2]
LOADER = ROOT / "src" / "whitebox" / "dist" / "scoring" / "rubricLoader.js"
SNAPSHOT = ROOT / "src" / "whitebox" / "dist" / "agents" / "normalization" / "ruleAssistance.js"
try:
    import yaml  # noqa: F401
    HAS_YAML = True
except ImportError:
    HAS_YAML = False


@unittest.skipUnless(HAS_YAML and shutil.which("node") and LOADER.is_file() and SNAPSHOT.is_file(),
                     "PyYAML or built whitebox files unavailable")
class WhiteboxRubricParityTests(unittest.TestCase):
    def test_all_task_templates_match(self):
        reference = ROOT / "src" / "whitebox" / "references" / "scoring"
        source = ("import {loadRubricForTaskType} from " + json.dumps(LOADER.as_uri()) + ";"
                  "import {buildRubricSnapshot} from " + json.dumps(SNAPSHOT.as_uri()) + ";"
                  "const rubric=await loadRubricForTaskType(process.argv[1],process.argv[2]);"
                  "process.stdout.write(JSON.stringify({rubric,snapshot:buildRubricSnapshot(rubric)}));")
        for task_type in ("full_generation", "continuation", "bug_fix"):
            with self.subTest(task_type=task_type):
                node = subprocess.run(["node", "--input-type=module", "-e", source, task_type, str(reference)],
                                      capture_output=True, text=True, check=True, cwd=ROOT / "src" / "whitebox")
                expected = json.loads(node.stdout)
                actual = load_rubric(task_type, reference)
                self.assertEqual(actual, expected["rubric"])
                self.assertEqual(rubric_snapshot(actual), expected["snapshot"])


if __name__ == "__main__":
    unittest.main()

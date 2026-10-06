"""Project and patch preprocessing parity for Python task understanding."""

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from pyautorun.whitebox_understanding import patch_summary, project_structure


ROOT = Path(__file__).resolve().parents[2]
WHITEBOX = ROOT / "src" / "whitebox"
TOOLS = WHITEBOX / "dist" / "workflow" / "nodes" / "taskUnderstanding" / "tools.js"


@unittest.skipUnless(shutil.which("node") and TOOLS.is_file(), "built task understanding unavailable")
class UnderstandingParityTests(unittest.TestCase):
    def test_project_and_patch(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for relative in ("entry/src/main/module.json5", "entry/src/main/ets/pages/Main.ets",
                             "entry/src/main/ets/components/Nav.ets", "entry/src/main/resources/base.json",
                             "feature/src/main/module.json5", ".git/config", "node_modules/pkg/a.ts"):
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("test", encoding="utf-8")
            patch = ("diff --git a/entry/src/main/ets/pages/Main.ets b/entry/src/main/ets/pages/Main.ets\n"
                     "--- a/entry/src/main/ets/pages/Main.ets\n"
                     "+++ b/entry/src/main/ets/pages/Main.ets\n"
                     "@@ -1 +1 @@\n-old\n+new\n")
            source = ("import {collectProjectStructure,summarizePatch} from " + json.dumps(TOOLS.as_uri()) + ";"
                      "process.stdout.write(JSON.stringify({structure:await collectProjectStructure(process.argv[1]),"
                      "patch:summarizePatch(process.argv[2])}));")
            node = subprocess.run(["node", "--input-type=module", "-e", source, str(root), patch],
                                  cwd=WHITEBOX, check=True, text=True, capture_output=True)
            expected = json.loads(node.stdout)
            self.assertEqual(project_structure(str(root)), expected["structure"])
            self.assertEqual(patch_summary(patch), expected["patch"])


if __name__ == "__main__":
    unittest.main()

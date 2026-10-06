"""Python patch generation matches the original whitebox patch generator."""

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from pyautorun.whitebox_patch import generate_project_patch


ROOT = Path(__file__).resolve().parents[2]
WHITEBOX = ROOT / "src" / "whitebox"
GENERATOR = WHITEBOX / "dist" / "commons" / "io" / "patchGenerator.js"


@unittest.skipUnless(shutil.which("git") and shutil.which("node") and GENERATOR.is_file(),
                     "built patch generator unavailable")
class WhiteboxPatchTests(unittest.TestCase):
    def test_generate(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old = root / "original"
            new = root / "workspace"
            for folder in (old, new):
                (folder / "entry").mkdir(parents=True)
            (old / "entry" / "Page.ets").write_text("old\n", encoding="utf-8")
            (new / "entry" / "Page.ets").write_text("new\n", encoding="utf-8")
            (new / "entry" / "Feature.ets").write_text("feature\n", encoding="utf-8")
            python_output = root / "python.patch"
            node_output = root / "node.patch"
            generate_project_patch(old, new, python_output)
            source = ("import {generateProjectPatch} from " + json.dumps(GENERATOR.as_uri()) + ";"
                      "await generateProjectPatch(process.argv[1],process.argv[2],process.argv[3]);")
            subprocess.run(["node", "--input-type=module", "-e", source, str(old), str(new), str(node_output)],
                           cwd=WHITEBOX, check=True, capture_output=True)
            self.assertEqual(python_output.read_text(encoding="utf-8"),
                             node_output.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()

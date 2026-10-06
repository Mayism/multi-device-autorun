"""Whitebox agent sandbox excludes private files and outside links."""

from pathlib import Path
import tempfile
import unittest

from pyautorun.whitebox_eval.runtime.sandbox import build_sandbox


class WhiteboxSandboxTests(unittest.TestCase):
    def test_filtered_source_snapshot(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            generated = root / "generated-project"
            generated.mkdir()
            (generated / "Page.ets").write_text("Text('ok')", encoding="utf-8")
            (generated / ".env").write_text("secret", encoding="utf-8")
            (generated / "node_modules").mkdir()
            (generated / "node_modules" / "dep.ts").write_text("dep", encoding="utf-8")
            (root / "outside.txt").write_text("outside", encoding="utf-8")
            (generated / "escape.txt").symlink_to(root / "outside.txt")
            sandbox = build_sandbox(root / "case", generated, metadata={"case_id": "example"})
            view = Path(sandbox["generatedRoot"])
            self.assertTrue((view / "Page.ets").is_file())
            self.assertFalse((view / ".env").exists())
            self.assertFalse((view / "node_modules").exists())
            self.assertFalse((view / "escape.txt").exists())


if __name__ == "__main__":
    unittest.main()

"""Integration checks for Python case artifacts and recovery."""

import asyncio
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from harmonyeval.utils.git import excluded, filter_patch, initialize_git_baseline, generate_patch, prune_project


class ArtifactTests(unittest.TestCase):
    def test_patch_excludes_ohpm_lockfiles_but_keeps_dependency_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "project"
            project.mkdir()
            manifest = project / "oh-package.json5"
            lockfile = project / "oh-package-lock.json5"
            manifest.write_text('{"dependencies": {}}\n', encoding="utf-8")
            initialize_git_baseline(project)
            lockfile.write_text('{"baseline": true}\n', encoding="utf-8")
            subprocess.run(["git", "add", "-f", "oh-package-lock.json5"], cwd=project, check=True)
            subprocess.run(["git", "commit", "-m", "tracked lockfile"], cwd=project,
                           check=True, capture_output=True)
            baseline = subprocess.run(["git", "rev-parse", "HEAD"], cwd=project,
                                      check=True, capture_output=True, text=True).stdout.strip()

            manifest.write_text('{"dependencies": {"lib": "1.0.0"}}\n', encoding="utf-8")
            lockfile.write_text('{"installed": true}\n', encoding="utf-8")
            nested = project / "entry"
            nested.mkdir()
            (nested / "oh-package-lock.json5").write_text('{"installed": true}\n', encoding="utf-8")
            patch_path = Path(temp) / "changes.patch"
            generate_patch(project, baseline, patch_path)
            content = patch_path.read_text(encoding="utf-8")
            self.assertIn("oh-package.json5", content)
            self.assertNotIn("oh-package-lock.json5", content)
            self.assertTrue(excluded("entry/oh-package-lock.json5"))
            self.assertFalse(excluded("entry/oh-package.json5"))

    def test_filtered_patch_keeps_web_changes_and_prunes_transients(self):
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp)
            (project / "web").mkdir()
            (project / "web" / "index.html").write_text("before", encoding="utf-8")
            baseline = initialize_git_baseline(project)
            (project / "web" / "index.html").write_text("after", encoding="utf-8")
            (project / ".onemulti").mkdir()
            (project / ".onemulti" / "decisions.json").write_text("{}", encoding="utf-8")
            (project / "__pycache__").mkdir()
            (project / "__pycache__" / "x.pyc").write_bytes(b"x")
            patch_path = project.parent / "changes.patch"
            generate_patch(project, baseline, patch_path)
            changed = patch_path.read_text(encoding="utf-8")
            self.assertIn("web/index.html", changed)
            self.assertNotIn(".onemulti", changed)
            self.assertTrue(excluded("web/.onemulti/file"))
            self.assertFalse(excluded("web/index.html"))
            self.assertEqual(prune_project(project), ["__pycache__"])
            self.assertTrue((project / ".onemulti" / "decisions.json").exists())
            self.assertEqual(filter_patch("plain"), "plain")

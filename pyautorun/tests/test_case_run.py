"""Integration checks for Python case artifacts and recovery."""

import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pyautorun.orchestration.artifacts import excluded, filter_patch, initialize_git_baseline, generate_patch, prune_project
from pyautorun.orchestration.batch_state import BatchStateStore, load_retry_plan, recover_interrupted_runs
from pyautorun.orchestration.case_run import run_case, write_json


class ArtifactTests(unittest.TestCase):
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


class CaseRunTests(unittest.TestCase):
    def test_python_case_writes_result_patch_and_logs(self):
        class Client:
            async def create_session(self, *_args):
                return {"id": "session"}

            async def list_messages(self, *_args):
                return [{"info": {"id": "done", "role": "assistant", "tokens": {"input": 1, "output": 2}},
                         "parts": [{"type": "text", "text": "完成"}]}]

        async def monitored(_client, _session_id, project_dir, *_args, **_kwargs):
            (Path(project_dir) / "web" / "index.html").write_text("adapted", encoding="utf-8")
            return {"output": "完成", "message": {"info": {"finish": "stop"}},
                    "childSessionIds": [], "finishReason": "stop", "tokenUsage": {"total": 3}}

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            case = root / "cases" / "WebCase"
            (case / "base").mkdir(parents=True)
            (case / "web").mkdir()
            (case / "base" / "main.txt").write_text("native", encoding="utf-8")
            (case / "web" / "index.html").write_text("before", encoding="utf-8")
            (case / "PROMPT.md").write_text("adapt", encoding="utf-8")
            batch = root / "output" / "run" / "target"
            batch.mkdir(parents=True)
            info = {"name": "WebCase", "caseRoot": str(case), "projectName": "base",
                    "projectDir": str(case / "base"), "webProjectDir": str(case / "web"),
                    "promptPath": str(case / "PROMPT.md"), "platform": "web"}
            state = {"cases": {"WebCase": {"status": "pending"}}}
            store = BatchStateStore(batch / "batch.json", state)
            with patch("pyautorun.orchestration.case_run.run_monitored_session", monitored):
                result = asyncio.run(run_case(info, batch, Client(), {"providerId": "p", "modelId": "m"},
                                              {"agent": "a"}, {"skills": [], "toolReadRoots": []}, store))
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["tokenUsage"]["total"], 3)
            self.assertIn("web/index.html", Path(result["patchPath"]).read_text(encoding="utf-8"))
            self.assertFalse((batch / "WebCase" / "original").exists())
            self.assertEqual((batch / "WebCase" / "web" / "index.html").read_text(), "adapted")
            self.assertEqual(json.loads(Path(result["resultPath"]).read_text())["sessionId"], "session")

    def test_retry_recovery_marks_dead_batch_and_selects_case(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            batch = root / "run" / "target"
            batch.mkdir(parents=True)
            state = {"batchId": "run", "targetId": "target", "status": "running",
                     "cases": {"a": {"status": "running", "runDir": str(batch / "a")},
                               "b": {"status": "pending"}}}
            write_json(batch / "batch.json", state)
            (batch / "batch.pid").write_text("999999999")
            self.assertEqual(recover_interrupted_runs(root), [str(batch)])
            recovered = json.loads((batch / "batch.json").read_text())
            self.assertEqual(recovered["cases"]["a"]["status"], "interrupted")
            self.assertEqual(recovered["cases"]["b"]["status"], "cancelled")
            plan = load_retry_plan(root, "run")
            self.assertEqual(plan["selectedCaseNames"], ["a", "b"])
            with self.assertRaisesRegex(ValueError, "无效的重试批次"):
                load_retry_plan(root, "../elsewhere")

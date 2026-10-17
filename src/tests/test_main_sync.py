"""Regression checks for main features ported to the Python branch."""

import asyncio
from contextlib import nullcontext
from hashlib import sha1
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pyautorun.devices.ohostest import normalize_config
from pyautorun.devices.ohostest_case import run_ohostest_for_batch
from pyautorun.orchestration.artifacts import generate_patch, initialize_git_baseline
from pyautorun.orchestration.interaction import automatic_question_answers
from pyautorun.runtime.session_monitor import run_monitored_session
from pyautorun.runtime.text_confirmation import automatic_text_reply


class PortedMainBehaviorTests(unittest.TestCase):
    def test_automatic_confirmations_keep_manual_review_pending(self):
        self.assertEqual(automatic_text_reply("是否继续执行当前任务？")["reason"], "workflow_confirmation")
        self.assertIsNone(automatic_text_reply("请确认当前页面效果是否满意？"))
        self.assertEqual(automatic_text_reply("当前模型未通过图片理解探测，请回复仅基础测试")["text"],
                         "仅基础测试")
        self.assertEqual(automatic_question_answers([{"question": "图片理解探测失败，是否仅基础测试？",
                     "options": [{"label": "继续视觉测试"}, {"label": "仅基础测试"}]}]), [["仅基础测试"]])
        self.assertEqual(automatic_question_answers([{"question": "请确认当前页面效果是否满意？",
                     "options": [{"label": "满意"}, {"label": "不满意"}]}]), [])

    def test_patch_uses_sanitized_index_and_keeps_agent_edits(self):
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "project"
            project.mkdir()
            profile = project / "BuildProfile.ets"
            profile.write_text("export const BUILD_MODE_NAME = 'test';\nexport const FEATURE = 1;\n", encoding="utf-8")
            baseline = initialize_git_baseline(project)
            profile.write_text("export const BUILD_MODE_NAME = 'debug';\nexport const FEATURE = 2;\n", encoding="utf-8")
            (project / "layout.json").write_text("", encoding="utf-8")
            (project / "layout_7.json").write_text("generated", encoding="utf-8")
            patch_path = Path(temp) / "changes.patch"
            generate_patch(project, baseline, patch_path)
            content = patch_path.read_text(encoding="utf-8")
            self.assertIn("FEATURE = 2", content)
            self.assertNotIn("BUILD_MODE_NAME = 'debug'", content)
            self.assertNotIn("layout.json", content)
            self.assertNotIn("layout_7.json", content)
            self.assertIn("BUILD_MODE_NAME = 'debug'", profile.read_text(encoding="utf-8"))

    def test_rn_runner_uses_short_root_and_retains_golden_patch(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            case = root / "CaseA"
            (case / "base").mkdir(parents=True)
            (case / "base" / "package.json").write_text('{"dependencies":{"react-native":"1"}}', encoding="utf-8")
            (case / "result.json").write_text("{}", encoding="utf-8")
            golden = case / "golden.patch"
            golden.write_text("golden", encoding="utf-8")
            short_root = root / "rn"
            stale = short_root / sha1(b"CaseA").hexdigest()[:8]
            stale.mkdir(parents=True)
            (stale / "old").write_text("stale", encoding="utf-8")
            settings = normalize_config({"config": {"ohosTest": {"enabled": True,
                                  "rnWorkRoot": str(short_root)}, "server": {}}})
            staged = {"metadataPath": str(case / "metadata.json"), "testPatchPath": str(case / "test.patch"),
                      "goldenPatchPath": str(golden)}
            commands = []

            class Process:
                returncode = 0
                pid = 123

                def wait(self, timeout=None):
                    return 0

            def popen(command, **_kwargs):
                commands.append(command)
                out = Path(command[command.index("--out") + 1])
                (out / "work" / "project").mkdir(parents=True)
                (out / "result.json").write_text(json.dumps({"status": "completed"}), encoding="utf-8")
                (out / "summary.md").write_text("ok", encoding="utf-8")
                return Process()

            with patch("pyautorun.devices.ohostest_case.stage_generated_case", return_value=staged), \
                 patch("pyautorun.devices.ohostest_case.device_lease", return_value=nullcontext()), \
                 patch("pyautorun.devices.ohostest_case.subprocess.Popen", side_effect=popen):
                result = asyncio.run(run_ohostest_for_batch(
                    {"name": "CaseA", "projectName": "base"},
                    {"resultPath": str(case / "result.json"), "patchPath": str(case / "diff.patch")}, settings, root))
            self.assertEqual(result["status"], "completed")
            self.assertEqual(Path(result["outputDir"]).parent.name, ".ohostest-runs")
            self.assertTrue(Path(result["machineConfigPath"]).is_file())
            self.assertFalse((Path(result["outputDir"]) / "work").exists())
            self.assertFalse((case / "ohostest-workdir").exists())
            self.assertTrue(golden.is_file())
            self.assertEqual(list(short_root.iterdir()), [])
            self.assertNotIn("--keep-workdir", commands[0])

    def test_question_reply_waits_for_new_assistant_message(self):
        class Client:
            base_url = "http://127.0.0.1:1"

            def __init__(self):
                self.prompts = []
                self.answered = False
                self.after_answer_polls = 0

            async def prompt_async(self, _session, payload, *_args):
                self.prompts.append(payload)

            async def list_messages(self, *_args):
                if self.answered:
                    self.after_answer_polls += 1
                done = self.answered and self.after_answer_polls > 1
                return [{"info": {"id": "done" if done else "question", "role": "assistant",
                                  "finish": "stop"},
                         "parts": [{"type": "text", "text": "最终完成" if done else "是否继续执行当前任务？"},
                                   {"type": "step-finish"}]}]

            async def list_children(self, *_args):
                return []

            async def list_todos(self, *_args):
                return []

            async def list_questions(self, *_args):
                return [] if self.answered else [{"id": "q1", "questions": [
                    {"question": "是否继续执行当前任务？", "options": [{"label": "继续"}]}]}]

            async def reply_question(self, *_args):
                self.answered = True

            async def list_permissions(self, *_args):
                return []

            async def abort_session(self, *_args):
                return {}

        client = Client()
        with tempfile.TemporaryDirectory() as temp:
            result = asyncio.run(run_monitored_session(client, "session", temp,
                                 {"parts": [{"type": "text", "text": "work"}]},
                                 Path(temp) / "events.jsonl", Path(temp) / "polling.jsonl",
                                 idle_timeout_sec=12, max_runtime_sec=12))
        self.assertEqual(result["output"], "最终完成")
        self.assertEqual(len(client.prompts), 1)


if __name__ == "__main__":
    unittest.main()

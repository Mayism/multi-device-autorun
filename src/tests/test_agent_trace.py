"""Offline Agent trace and artifact exclusion checks."""

import json
from pathlib import Path
import tempfile
import unittest
from zipfile import ZipFile

from pyautorun.orchestration.artifact_cleanup import cleanup_case_metadata
from pyautorun.reporting.agent_trace import _duration, _tokens, normalize_agent_trace, write_agent_trace
from pyautorun.reporting.archive_cases import archive_cases
from pyautorun.reporting.reports import write_batch_report


class AgentTraceTests(unittest.TestCase):
    def test_trace_renders_messages_tools_and_safe_embedded_json(self):
        sessions = [{"sessionId": "s1", "messages": [
            {"info": {"role": "user", "id": "m1"}, "parts": [{"type": "text", "text": "prompt"}]},
            {"info": {"role": "assistant", "id": "m2"}, "parts": [
                {"type": "reasoning", "text": "think"},
                {"type": "tool", "tool": "bash", "state": {"status": "completed", "input": {"cmd": "echo"},
                                                                "output": "</script><img src=x>"}},
                {"type": "text", "text": "done"}, {"type": "step-finish"}]}]}]
        entries = normalize_agent_trace(sessions)[0]["entries"]
        self.assertEqual([item["kind"] for item in entries], ["text", "reasoning", "tool", "text"])
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "all-messages.json"
            source.write_text(json.dumps(sessions), encoding="utf-8")
            target = write_agent_trace(source, case_name="CaseA", agent_status="completed",
                                       started_at="2026-01-01T00:00:00Z", finished_at="2026-01-01T01:01:01Z",
                                       token_usage={"total": 123456})
            html = Path(target).read_text(encoding="utf-8")
            self.assertIn("01:01:01", html)
            self.assertIn("123.5k", html)
            self.assertIn("搜索回复、工具名", html)
            self.assertNotIn("</script><img", html)
            self.assertIn("\\u003c/script\\u003e", html)
            failed = write_agent_trace(source, case_name="CaseA", agent_status="failed",
                                       agent_error="API error", token_usage={"total": 0})
            self.assertIn("Agent 执行错误", Path(failed).read_text(encoding="utf-8"))
        self.assertEqual(_duration("bad", "bad"), "--")
        self.assertEqual(_tokens(1_000_000), "1,000k")

    def test_summary_cleanup_and_zip_omit_only_transient_case_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            case = root / "CaseA"
            (case / "generate").mkdir(parents=True)
            (case / ".ohostest-runs" / "run-1").mkdir(parents=True)
            for relative in ("result.json", "state.json", "session.json", "generate/input.txt",
                             "generate/last-message.json", "generate/skill-runtime.json", "generate/output.txt",
                             "generate/final-message.json"):
                (case / relative).write_text("temporary", encoding="utf-8")
            (case / ".ohostest-runs" / "run-1" / "result.json").write_text("runner", encoding="utf-8")
            (case / "generate" / "all-messages.json").write_text("[]", encoding="utf-8")
            summary = {"batchId": "batch", "results": [{"case": "CaseA"}]}
            with self.assertRaises(FileNotFoundError):
                cleanup_case_metadata(root, summary)
            archive_cases(root, summary)
            with ZipFile(case / "CaseA_batch.zip") as archive:
                names = archive.namelist()
                self.assertIn(".ohostest-runs/run-1/result.json", names)
                self.assertIn("generate/all-messages.json", names)
                self.assertNotIn("result.json", names)
                self.assertNotIn("generate/output.txt", names)
            (root / "summary.json").write_text(json.dumps(summary), encoding="utf-8")
            self.assertEqual(cleanup_case_metadata(root, summary), [])
            self.assertFalse((case / "result.json").exists())
            self.assertFalse((case / "generate" / "final-message.json").exists())

    def test_report_regeneration_writes_trace_and_case_link(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            generate = root / "CaseA" / "generate"
            generate.mkdir(parents=True)
            source = generate / "all-messages.json"
            source.write_text(json.dumps([{"sessionId": "s1", "messages": []}]), encoding="utf-8")
            result = {"case": "CaseA", "status": "completed", "agentStatus": "completed",
                      "logs": {"messagesPath": str(source)}}
            summary = {"batchId": "batch", "status": "completed", "total": 1, "completed": 1,
                       "failed": 0, "results": [result]}
            write_batch_report(root, summary)
            self.assertTrue((generate / "agent-output.html").is_file())
            self.assertIn("agent-output.html", (root / "subpage" / "CaseA.html").read_text(encoding="utf-8"))
            self.assertFalse((root / "upload-results.json").exists())


if __name__ == "__main__":
    unittest.main()

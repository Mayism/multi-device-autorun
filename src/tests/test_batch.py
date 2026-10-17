"""Batch scheduling and offline report integration checks."""

import asyncio
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pyautorun.orchestration.batch import run_batch
from pyautorun.orchestration.case_run import write_json
from pyautorun.reporting.reports import merge_overview, write_comparison_report


class BatchTests(unittest.TestCase):
    def test_postvalidation_keeps_agent_timeout_status(self):
        class Server:
            client = object()
            server_config = {}

        async def validate(*_args):
            return {"providerId": "p", "modelId": "m"}

        async def failed_case(item, root, *_args, **_kwargs):
            directory = Path(root) / item["name"]
            directory.mkdir(parents=True)
            result = {"case": item["name"], "status": "timed_out", "agentStatus": "timed_out",
                      "agentError": "Agent timed out", "resultPath": str(directory / "result.json"),
                      "projectDir": str(directory / "base"), "patchPath": ""}
            write_json(result["resultPath"], result)
            error = TimeoutError("Agent timed out")
            error.case_result = result
            raise error

        async def passed_ohostest(*_args):
            return {"status": "completed", "error": ""}

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            case = root / "cases" / "CaseA"
            (case / "base").mkdir(parents=True)
            (case / "PROMPT.md").write_text("work")
            (case / "metadata.json").write_text(json.dumps({"case_id": "CaseA", "base_project": "base",
                "test_patch": "test.patch", "golden_patch": "golden.patch"}))
            (case / "test.patch").write_text("patch")
            (case / "golden.patch").write_text("patch")
            config = {"server": {"opencodeSource": {"mode": "harmonyBot", "agent": "a"}},
                      "execution": {"casesRoot": str(case.parent), "outputRoot": str(root / "out"),
                                    "agent": "a", "model": "m", "concurrency": 1},
                      "ohosTest": {"enabled": True, "devices": [{"id": "phone", "target": "127.0.0.1:15001"}]},
                      "cloudTest": {"enabled": False}, "whiteboxEvaluation": {"enabled": False}}
            with patch("pyautorun.orchestration.batch.validate_server_config", validate), \
                 patch("pyautorun.orchestration.batch.run_case", failed_case), \
                 patch("pyautorun.orchestration.batch.analyze_uitest_failures", return_value=None):
                summary = asyncio.run(run_batch(config, Server(), {}, "run", root / "out" / "run", "agent",
                                                ohostest_runner=passed_ohostest))
            self.assertEqual(summary["results"][0]["status"], "timed_out")
            self.assertEqual(summary["failed"], 1)

    def test_python_batch_runs_cases_and_writes_reports(self):
        class Server:
            client = object()
            server_config = {"provider": {"p": {"models": {"m": {}}}}, "agent": {"a": {}}}

        async def validate(*_args):
            return {"providerId": "p", "modelId": "m"}

        async def case_run(item, root, _client, model, execution, _skills, store, **_options):
            directory = Path(root) / item["name"]
            directory.mkdir(parents=True)
            result = {"case": item["name"], "status": "completed", "agentStatus": "completed",
                      "agent": execution["agent"], "providerId": model["providerId"],
                      "modelId": model["modelId"], "resultPath": str(directory / "result.json"),
                      "elapsedSec": 1, "tokenUsage": {"input": 1, "output": 2, "total": 3},
                      "agentCompile": {"attempts": 0}}
            write_json(result["resultPath"], result)
            store.set_case(item["name"], {"status": "completed", "resultPath": result["resultPath"]})
            return result

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cases = root / "cases"
            for name in ("CaseA", "CaseB"):
                case = cases / name
                (case / "base").mkdir(parents=True)
                (case / "PROMPT.md").write_text("work", encoding="utf-8")
            config = {"server": {"opencodeSource": {"mode": "harmonyBot", "agent": "a"}},
                      "execution": {"casesRoot": str(cases), "outputRoot": str(root / "out"),
                                    "agent": "a", "model": "m", "concurrency": 2},
                      "ohosTest": {"enabled": False}, "cloudTest": {"enabled": False},
                      "whiteboxEvaluation": {"enabled": False}}
            target = root / "out" / "run" / "agent"
            output = io.StringIO()
            with patch("pyautorun.orchestration.batch.validate_server_config", validate), \
                 patch("pyautorun.orchestration.batch.run_case", case_run), redirect_stdout(output):
                summary = asyncio.run(run_batch(config, Server(), {}, "run", target, "agent",
                                                environment={"generationModel": {"configFingerprint": "fp"},
                                                             "skills": {"loaded": ["sample"]}}))
            self.assertEqual(summary["completed"], 2)
            self.assertEqual(summary["environment"]["skills"]["loaded"], ["sample"])
            self.assertFalse((target / "environment.json").exists())
            self.assertEqual(output.getvalue().count("生成状态"), 1)
            self.assertIn("CaseA", output.getvalue())
            self.assertIn("CaseB", output.getvalue())
            self.assertEqual(json.loads((target / "report.json").read_text())["schemaVersion"],
                             "autorun-batch-report-v1")
            self.assertTrue((target / "overview.html").is_file())
            self.assertTrue((target / "subpage" / "CaseA.html").is_file())
            self.assertFalse((target / "batch.pid").exists())
            self.assertFalse((target / "batch.json").exists())
            self.assertFalse((target / "CaseA" / "result.json").exists())
            self.assertTrue((target / "summary.json").is_file())
            comparison = write_comparison_report(root / "out" / "run", "run",
                                                 {"providerId": "p", "modelId": "m"},
                                                 [{"id": "agent", "label": "Agent", "mode": "harmonyBot",
                                                   "targetRoot": str(target)}])
            self.assertTrue(Path(comparison["overviewPath"]).is_file())
            merged = merge_overview(root / "out")
            self.assertEqual(merged["batchCount"], 1)


if __name__ == "__main__":
    unittest.main()

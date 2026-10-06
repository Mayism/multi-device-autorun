"""Verify that Autorun publishes the Python-rendered whitebox report."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from pyautorun.whitebox_adapter import WhiteboxEvaluator
from pyautorun.whitebox_report import render_whitebox_html


class WhiteboxAdapterReportTests(unittest.TestCase):
    def _run_completed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "whitebox"
            result_path = output / "outputs" / "result.json"
            result_path.parent.mkdir(parents=True)
            result = {"overall_conclusion": {"total_score": 80, "summary": "完成"}}
            result_path.write_text(json.dumps(result), encoding="utf-8")
            input_path = root / "input.json"
            input_path.write_text("{}", encoding="utf-8")
            evaluator = WhiteboxEvaluator.__new__(WhiteboxEvaluator)
            evaluator.config = {"timeoutSec": 10, "runtimeRoot": str(root),
                                "officialLinter": {"enabled": False},
                                "hvigorBuildCheck": {"enabled": False}}
            evaluator.judge_runtime = {"providerId": "test", "modelId": "test", "providerConfig": {}}
            evaluator.opencode_bin = "/usr/bin/true"
            evaluator.repo_root = root
            completed = subprocess.CompletedProcess([], 0, json.dumps({"status": "completed",
                                                                        "resultPath": str(result_path)}), "")
            with patch("pyautorun.whitebox_adapter.subprocess.run", return_value=completed) as run_process, \
                 patch("pyautorun.whitebox_adapter.validate_whitebox_result"):
                actual = evaluator._run({"inputPath": str(input_path), "outputDir": str(output)}, 4000)
            self.assertEqual(run_process.call_args.args[0][:3],
                             [sys.executable, "-m", "pyautorun.whitebox_local"])
            self.assertEqual(run_process.call_args.kwargs["env"]["PYTHONPATH"].split(os.pathsep)[0], str(root))
            return actual, (output / "report.html").read_text(encoding="utf-8"), render_whitebox_html(result)

    def test_completed_result_is_rendered_by_python(self):
        actual, written, expected = self._run_completed()
        self.assertEqual(actual["status"], "completed")
        self.assertEqual(written, expected)

if __name__ == "__main__":
    unittest.main()

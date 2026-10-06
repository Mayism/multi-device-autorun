"""Python ohosTest staging and result tests."""

import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from pyautorun.devices.ohostest_case import run_ohostest_case, stage_generated_case
from pyautorun.devices.ohostest_project import load_case_metadata, select_devices
from pyautorun.devices.ohostest_fold import deploy_fold_trigger
from pyautorun.devices.ohostest_web import WebForwarding
from pyautorun.devices.ohostest_execution import CommandLog, run_device
from pyautorun.devices.ohostest_compat import temporary_device_types, apply_answer_device_type_checks
from pyautorun.devices.ohostest_matrix import run_matrix


class OhosTestCaseTests(unittest.TestCase):
    def test_temporary_device_type_restored_and_answer_marks_missing_declaration(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            module = root / "entry" / "src" / "main" / "module.json5"
            module.parent.mkdir(parents=True)
            original = '{"module":{"deviceTypes":["phone"]}}\n'
            module.write_text(original, encoding="utf-8")
            config = {"project": temp, "moduleSrcPath": "entry", "sharedModules": []}
            with temporary_device_types(config, ["tablet"]) as assessment:
                self.assertIn("tablet", module.read_text(encoding="utf-8"))
            self.assertEqual(module.read_text(encoding="utf-8"), original)
            result = {"status": "completed", "devices": [{"id": "tablet", "status": "passed",
                      "testsRun": 1, "failures": 0, "passes": 1, "suiteResults": []}]}
            apply_answer_device_type_checks(result, assessment)
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["devices"][0]["suiteResults"][0]["suiteClass"],
                             "ModuleDeviceTypeCompatibility")

    def test_matrix_writes_failure_result_when_project_is_invalid(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "result.json"
            result = run_matrix(temp, {}, output)
            self.assertEqual(result["status"], "failed")
            self.assertTrue(output.is_file())
            self.assertTrue((output.parent / "summary.md").is_file())

    def test_device_execution_uses_python_hdc_transport(self):
        with tempfile.TemporaryDirectory() as temp:
            seen = []
            def execute(command, _cwd, _timeout_ms, _detached):
                seen.append(command)
                stdout = ("127.0.0.1:15001\n" if "list targets" in command else
                          "screenLocked: false" if "ScreenlockService" in command else
                          "Tests run: 1, Failure: 0, Error: 0, Pass: 1, Ignore: 0\nOHOS_REPORT_CODE: 0"
                          if "shell aa test" in command else "")
                return {"exitCode": 0, "stdout": stdout, "stderr": "", "durationMs": 1}
            log = CommandLog(Path(temp) / "commands.jsonl", execute)
            config = {"project": temp, "paths": {"hdc": "hdc"}, "bundleName": "com.example.app",
                      "testModule": "entry_test", "testRunner": "OpenHarmonyTestRunner",
                      "testCaseTimeoutMs": 15000, "timeoutMs": 120000}
            device = {"id": "phone", "target": "127.0.0.1:15001", "startEmulator": False}
            artifacts = {"appHap": "app.hap", "testHap": "test.hap", "hspPaths": []}
            with patch("pyautorun.devices.ohostest_device._sleep", lambda *_args: None):
                result = run_device(config, device, artifacts, ["PhoneTest"], log)
            self.assertEqual(result["status"], "passed")
            self.assertEqual(result["passes"], 1)
            self.assertTrue(any("shell aa test" in command for command in seen))

    def test_fold_trigger_and_web_forwarding_use_python_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            target = deploy_fold_trigger(temp, "entry", 8770)
            self.assertIn("const FOLD_SERVER_PORT = 8770;", target.read_text(encoding="utf-8"))
            class Log:
                def __init__(self):
                    self.commands = []
                    self.mapped = False

                def run(self, command, *_args):
                    self.commands.append(command)
                    if " rport " in command:
                        self.mapped = True
                    elif " fport rm " in command:
                        self.mapped = False
                    return {"exitCode": 0, "stdout":
                            "tcp:5175 tcp:5175 [Reverse]" if " fport ls" in command and self.mapped else
                            "[OK]" if " rport " in command else "", "stderr": ""}
            log = Log()
            forwarding = WebForwarding("hdc", "127.0.0.1:15001", 5175, log, temp)
            forwarding.start()
            self.assertTrue(log.mapped)
            forwarding.stop()
            self.assertFalse(log.mapped)
            self.assertTrue(any(" rport " in item for item in log.commands))

    def test_stage_hidden_patches_only_after_agent(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            case = root / "CaseA"
            (case / "base").mkdir(parents=True)
            (case / "metadata.json").write_text(json.dumps({"case_id": "a", "base_project": "base",
                "test_patch": "test.patch", "golden_patch": "golden.patch"}), encoding="utf-8")
            (case / "test.patch").write_text("patch", encoding="utf-8")
            (case / "golden.patch").write_text("patch", encoding="utf-8")
            run = root / "run"
            (run / "base").mkdir(parents=True)
            (run / "diff").mkdir()
            (run / "diff" / "changes.patch").write_text("", encoding="utf-8")
            self.assertFalse((run / "test.patch").exists())
            staged = stage_generated_case({"caseRoot": str(case), "projectName": "base"}, run,
                                          run / "diff" / "changes.patch")
            self.assertEqual(Path(staged["testPatchPath"]).read_text(), "patch")
            self.assertEqual(load_case_metadata(run)["caseId"], "a")

    def test_suite_selection_ignores_pc_and_follows_metadata(self):
        metadata = {"deviceTestSuites": {"phone": [{"suite": "PhoneTest"}],
                                          "pc": [{"suite": "PcTest"}]}, "enabledDevices": None}
        selected = select_devices(metadata, {"devices": [{"id": "phone"}]})
        self.assertEqual(selected["devices"], ["phone"])
        self.assertEqual(selected["skippedDevices"], ["pc"])
        self.assertEqual(selected["deviceSuiteOverrides"], {"phone": ["PhoneTest"]})

    def test_failed_patch_writes_case_result(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            case = root / "CaseA"
            (case / "base").mkdir(parents=True)
            (case / "base" / "text.txt").write_text("original\n", encoding="utf-8")
            (case / "metadata.json").write_text(json.dumps({"case_id": "a", "base_project": "base",
                "test_patch": "test.patch", "golden_patch": "golden.patch"}), encoding="utf-8")
            (case / "test.patch").write_text("invalid patch", encoding="utf-8")
            (case / "golden.patch").write_text("invalid patch", encoding="utf-8")
            out = case / ".ohostest-runs" / "run"
            result = run_ohostest_case(case, {"devices": []}, out)
            self.assertEqual(result["status"], "failed")
            self.assertIn("patch_apply_failed", result["diagnostics"][0])
            self.assertEqual(json.loads((out / "result.json").read_text())["schemaVersion"],
                             "ohostest-case-v1")

    def test_native_case_completes_swe_and_answer_with_python_runner(self):
        with tempfile.TemporaryDirectory() as temp:
            case = Path(temp) / "CaseA"
            project = case / "base"
            main = project / "entry" / "src" / "main"
            test = project / "entry" / "src" / "ohosTest"
            main.mkdir(parents=True)
            test.mkdir(parents=True)
            (project / "AppScope").mkdir()
            (project / "build-profile.json5").write_text(
                '{"app":{"products":[{"name":"default"}]},"modules":[{"name":"entry","srcPath":"./entry"}]}')
            (project / "AppScope" / "app.json5").write_text('{"app":{"bundleName":"com.example.test"}}')
            (project / "entry" / "hvigorfile.ts").write_text("hapTasks")
            (main / "module.json5").write_text('{"module":{"deviceTypes":["phone"]}}')
            (test / "module.json5").write_text('{"module":{"name":"entry_test"}}')
            (project / "file.txt").write_text("old\n")
            (case / "metadata.json").write_text(json.dumps({"case_id": "CaseA", "base_project": "base",
                "test_patch": "test.patch", "golden_patch": "golden.patch",
                "device_test_suites": {"phone": [{"suite": "PhoneTest"}]}}))
            (case / "test.patch").write_text(
                "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+test\n")
            (case / "golden.patch").write_text(
                "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-test\n+answer\n")
            machine = {"paths": {"hvigorw": "hvigorw", "hdc": "hdc", "emulatorBin": "emulator",
                                 "emulatorDeployedDir": "images"},
                       "devices": [{"id": "phone", "target": "127.0.0.1:15001"}]}
            def fake_execution(config, selection, _out, _log, **_options):
                self.assertEqual(selection["devices"], ["phone"])
                return {"project": config["project"], "status": "completed", "startedAt": "now",
                        "finishedAt": "now", "durationMs": 1, "build": {"status": "passed"},
                        "diagnostics": [], "devices": [{"id": "phone", "status": "passed",
                        "testsRun": 1, "failures": 0, "errors": 0, "passes": 1, "ignored": 0,
                        "suiteResults": []}]}
            with patch("pyautorun.devices.ohostest_case.run_execution", fake_execution):
                result = run_ohostest_case(case, machine, case / ".ohostest-runs" / "run", "all")
            self.assertEqual(result["status"], "completed", result["diagnostics"])
            self.assertEqual(result["runs"]["answer"]["devices"][0]["passes"], 2)


if __name__ == "__main__":
    unittest.main()

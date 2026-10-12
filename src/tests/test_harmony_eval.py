"""Task YAML translation and report-based score dispatch."""

import json
import asyncio
from contextlib import redirect_stdout
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pyautorun.harmony_eval.scoring import register_scorer, score_case, summarize_scores, validate_scoring
from pyautorun.harmony_eval.task import _verification, load_harmony_task
from pyautorun.harmony_eval.verification import (VerificationSpec, Verifier, get_verifier,
                                                  normalize_task_verifications, register_verifier)
from pyautorun.orchestration.batch import run_batch
from pyautorun.orchestration.case_run import write_json
from pyautorun.reporting.batch_report import build_batch_report
from pyautorun.reporting.reports import _case_page
from pyautorun.runtime.opencode_installation import _node_arch, _node_platform, resolve_opencode_source


class HarmonyEvalTaskTests(unittest.TestCase):
    def test_builtin_verifier_adapters_keep_report_paths(self):
        self.assertEqual(get_verifier("UITest").legacy_result_key, "ohosTest")
        self.assertEqual(get_verifier("CloudTest").legacy_result_key, "cloudTest")
        self.assertEqual(get_verifier("LLM_judge").legacy_result_key, "whitebox")

        class Judge:
            judge = {"model": "fake"}

            async def schedule(self, task):
                return {"status": "completed", "resultPath": task["resultPath"]}

        async def exercise(root):
            cloud = get_verifier("CloudTest")(VerificationSpec("cloud", "CloudTest"))
            whitebox = get_verifier("Whitebox")(VerificationSpec("white", "Whitebox"))
            config = {"cloudTest": {"enabled": True}, "whiteboxEvaluation": {"enabled": True}}
            await cloud.prepare(config, root, {})
            await whitebox.prepare(config, root, {"whitebox_evaluator": Judge()})
            context = {"case_info": {"name": "CaseA"},
                       "agent_result": {"resultPath": str(root / "result.json"), "projectDir": str(root)},
                       "progress": lambda *_args: None, "run_id": "run", "execution": {}}
            cloud_result = await cloud.verify(context)
            whitebox_result = await whitebox.verify(context)
            return cloud.result(cloud_result), whitebox.result(whitebox_result)

        with tempfile.TemporaryDirectory() as directory, \
             patch("pyautorun.harmony_eval.verifiers.cloudtest_verifier.load_cloud_config",
                   return_value={"enabled": True, "testCategories": []}), \
             patch("pyautorun.harmony_eval.verifiers.cloudtest_verifier.submit_cloud_test_for_project",
                   return_value={"taskGroupId": "group"}), \
             patch("pyautorun.harmony_eval.verifiers.cloudtest_verifier.finish_cloud_test_polling",
                   return_value={"status": "completed", "resultPath": str(Path(directory) / "cloud.json")}), \
             patch("pyautorun.harmony_eval.verifiers.whitebox_verifier.prepare_whitebox_input",
                   return_value={"resultPath": str(Path(directory) / "whitebox.json")}):
            cloud_result, whitebox_result = asyncio.run(exercise(Path(directory)))
        self.assertTrue(cloud_result.report_path.endswith("cloud.json"))
        self.assertTrue(whitebox_result.report_path.endswith("whitebox.json"))

    def test_registered_verifier_and_rule_run_without_batch_branches(self):
        @register_verifier("SyntheticTest")
        class SyntheticVerifier(Verifier):
            async def verify(self, context):
                path = Path(context["agent_result"]["resultPath"]).with_name("synthetic.json")
                write_json(path, {"successes": 3, "total": 4})
                return {"status": "completed", "resultPath": str(path)}

        @register_scorer("SyntheticRatio", ("SyntheticTest",))
        def score_synthetic(report, _config):
            return report["successes"] / report["total"]

        specs, legacy, _shared = normalize_task_verifications(
            [{"id": "checks", "type": "SyntheticTest"}], Path("."))
        self.assertIs(get_verifier("SyntheticTest"), SyntheticVerifier)
        self.assertEqual(legacy["ohosTest"], {"enabled": False})
        rules = validate_scoring([{"dimension": "quality", "name": "SyntheticRatio",
                                   "verification": "checks"}], specs)

        class Server:
            client = object()
            server_config = {}

        async def validate(*_args):
            return {"providerId": "p", "modelId": "m"}

        async def run_case(item, root, *_args, **_kwargs):
            case_dir = Path(root) / item["name"]
            case_dir.mkdir(parents=True)
            result = {"case": item["name"], "status": "running", "agentStatus": "completed",
                      "resultPath": str(case_dir / "result.json")}
            write_json(result["resultPath"], result)
            return result

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            case = root / "cases" / "CaseA"
            (case / "base").mkdir(parents=True)
            (case / "PROMPT.md").write_text("work", encoding="utf-8")
            config = {"server": {"opencodeSource": {"mode": "harmonyBot", "agent": "agent"}},
                      "execution": {"casesRoot": str(case.parent), "outputRoot": str(root / "out"),
                                    "agent": "agent", "model": "m", "concurrency": 1},
                      "ohosTest": {"enabled": False}, "cloudTest": {"enabled": False},
                      "whiteboxEvaluation": {"enabled": False},
                      "harmonyEval": {"taskId": "test", "verification": [spec.to_dict() for spec in specs],
                                      "scoring": rules}}
            target = root / "out" / "run" / "agent"
            with patch("pyautorun.orchestration.batch.validate_server_config", validate), \
                 patch("pyautorun.orchestration.batch.run_case", run_case), redirect_stdout(io.StringIO()):
                summary = asyncio.run(run_batch(config, Server(), {}, "run", target, "agent"))
            result = summary["results"][0]
            self.assertEqual(result["verifications"]["checks"]["type"], "SyntheticTest")
            self.assertEqual(result["scoring"]["quality"]["score"], 0.75)
            self.assertEqual(summary["verifications"]["checks"]["completed"], 1)
            self.assertIn("checks", (target / "overview.html").read_text(encoding="utf-8"))
            report = json.loads((target / "report.json").read_text(encoding="utf-8"))
            self.assertEqual(report["verifications"]["checks"]["cases"][0]["reportPath"],
                             result["verifications"]["checks"]["reportPath"])
            self.assertEqual(score_case(rules, {"agentStatus": "failed"})["quality"]["status"], "unavailable")

    def test_batch_persists_scores_from_verifier_report(self):
        class Server:
            client = object()
            server_config = {}

        async def validate(*_args):
            return {"providerId": "p", "modelId": "m"}

        async def run_case(item, root, *_args, **_kwargs):
            case_dir = Path(root) / item["name"]
            case_dir.mkdir(parents=True)
            result = {"case": item["name"], "status": "completed", "agentStatus": "completed",
                      "resultPath": str(case_dir / "result.json"), "projectDir": str(case_dir / "base")}
            write_json(result["resultPath"], result)
            return result

        async def uitest(_case, agent_result, _settings, _root):
            report = Path(agent_result["resultPath"]).parent / "ui.json"
            write_json(report, {"runs": {"swe": {"devices": [
                {"status": "passed", "testsRun": 1, "failures": 0, "errors": 0},
            ]}}})
            return {"status": "completed", "resultPath": str(report)}

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            case = root / "cases" / "CaseA"
            (case / "base").mkdir(parents=True)
            (case / "PROMPT.md").write_text("work", encoding="utf-8")
            (case / "metadata.json").write_text(json.dumps({"base_project": "base",
                "test_patch": "test.patch", "golden_patch": "golden.patch"}), encoding="utf-8")
            (case / "test.patch").write_text("patch", encoding="utf-8")
            (case / "golden.patch").write_text("patch", encoding="utf-8")
            target_root = root / "out" / "run" / "harmonybot"
            config = {"server": {"opencodeSource": {"mode": "harmonyBot", "agent": "agent"}},
                      "execution": {"casesRoot": str(case.parent), "outputRoot": str(root / "out"),
                                    "agent": "agent", "model": "m", "concurrency": 1},
                      "ohosTest": {"enabled": True, "devices": [{"id": "phone"}]},
                      "cloudTest": {"enabled": False},
                      "whiteboxEvaluation": {"enabled": False},
                      "harmonyEval": {"taskId": "test", "scoring": [
                          {"dimension": "L1", "name": "BooleanScoring"}]}}
            with patch("pyautorun.orchestration.batch.validate_server_config", validate), \
                 patch("pyautorun.orchestration.batch.run_case", run_case), \
                 patch("pyautorun.harmony_eval.verifiers.uitest_verifier.analyze_uitest_failures", return_value=None), \
                 redirect_stdout(io.StringIO()):
                summary = asyncio.run(run_batch(config, Server(), {}, "run", target_root,
                                                "harmonybot", ohostest_runner=uitest))
            self.assertEqual(summary["results"][0]["scoring"]["L1"]["score"], 1.0)
            self.assertEqual(summary["harmonyEval"]["scores"]["L1"]["average"], 1.0)
            report = json.loads((target_root / "report.json").read_text(encoding="utf-8"))
            self.assertEqual(report["harmonyEval"]["scores"]["L1"]["average"], 1.0)

    def test_task_yaml_maps_model_agent_and_verifiers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            extension = root / "extension"
            resources = extension / "resources" / "opencode"
            binary = resources / "bin" / "test" / "opencode"
            binary.parent.mkdir(parents=True)
            binary.write_text("#!/bin/sh\n", encoding="utf-8")
            binary.chmod(0o755)
            (resources / "bundled-opencode.json").write_text(json.dumps({
                "platform": _node_platform(), "arch": _node_arch(),
                "exeRelativePath": "bin/test/opencode",
            }), encoding="utf-8")
            (resources / "opencode.json").write_text(json.dumps({
                "agent": {"harmonyos-multi-device": {"prompt": "harmonyos-ui-multi"}},
            }), encoding="utf-8")
            skill = resources / "skills" / "harmonyos-ui-multi"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text("---\nname: harmonyos-ui-multi\n---\n", encoding="utf-8")
            launcher = extension / "tools" / "plugin-cli" / "run-opencode-serve.mjs"
            launcher.parent.mkdir(parents=True)
            launcher.write_text("// test launcher\n", encoding="utf-8")
            (extension / "package.json").write_text(json.dumps({
                "publisher": "huaweideveloperserviceplatform", "name": "harmonyosdevassistantforvscode",
                "version": "0.0.1",
            }), encoding="utf-8")
            (root / "cases").mkdir()
            task = root / "task.yaml"
            task.write_text("""\
id: test-task
dataset:
  type: swe-bench-hm-multi-dev
  dir: cases
target:
  type: harmonybot_agent
  dir: extension
harmonybot_agent:
  rounds: 2
  execution:
    agent_name: 一多适配Agent
    model:
      name: qwen-plus
      base_url: https://example.test/v1
      api_key: TEST_HARMONY_EVAL_KEY
  verification:
    - type: UITest
      deveco_home: deveco
    - type: CloudTest
      test_categories:
        - category: 24
          timeSpan: 60
    - type: Whitebox
  scoring:
    - dimension: L1
      name: BooleanScoring
    - dimension: L2
      name: WeightedSummation
    - dimension: L3
      name: ImmediateValue
  report:
    output_dir: outputs
    format: html
""", encoding="utf-8")
            with patch.dict(os.environ, {"TEST_HARMONY_EVAL_KEY": "test-secret"}):
                config, rounds = load_harmony_task(task)
            self.assertEqual(rounds, 2)
            self.assertEqual(config["execution"]["agent"], "harmonyos-multi-device")
            self.assertEqual(config["execution"]["model"], "qwen-plus")
            self.assertEqual(config["execution"]["providerId"], "harmony-eval")
            self.assertEqual(config["server"]["url"], "http://127.0.0.1:61419")
            self.assertTrue(config["ohosTest"]["enabled"])
            self.assertTrue(config["cloudTest"]["enabled"])
            self.assertTrue(config["whiteboxEvaluation"]["enabled"])
            self.assertEqual([item["type"] for item in config["harmonyEval"]["verification"]],
                             ["UITest", "CloudTest", "Whitebox"])
            self.assertEqual([item["verification"] for item in config["harmonyEval"]["scoring"]],
                             ["UITest", "CloudTest", "Whitebox"])
            staged = resolve_opencode_source(config["server"]["opencodeSource"])
            opencode = json.loads((Path(staged["resourcesDir"]) / "opencode.json").read_text(encoding="utf-8"))
            self.assertEqual(opencode["provider"]["harmony-eval"]["models"]["qwen-plus"]["name"], "qwen-plus")
            self.assertEqual(opencode["provider"]["harmony-eval"]["options"]["apiKey"], "test-secret")
            self.assertNotIn("test-secret", repr(config))
            self.assertEqual((resources / "opencode.json").read_text(encoding="utf-8"), json.dumps({
                "agent": {"harmonyos-multi-device": {"prompt": "harmonyos-ui-multi"}},
            }))

            existing_provider_yaml = task.read_text(encoding="utf-8").replace(
                "      base_url: https://example.test/v1\n      api_key: TEST_HARMONY_EVAL_KEY\n",
                "      provider_id: existing-provider\n")
            task.write_text(existing_provider_yaml, encoding="utf-8")
            existing_config, _ = load_harmony_task(task)
            self.assertEqual(existing_config["execution"]["providerId"], "existing-provider")
            existing_source = resolve_opencode_source(existing_config["server"]["opencodeSource"])
            existing_opencode = json.loads((Path(existing_source["resourcesDir"]) / "opencode.json").read_text())
            self.assertNotIn("provider", existing_opencode)

    def test_disabled_verifier_keeps_cloud_signing_settings(self):
        verification = _verification([{"type": "CloudTest", "enabled": False,
                                       "signingConfigs": [{"name": "default"}]},
                                      {"type": "Whitebox", "enabled": False}], Path("."))
        self.assertFalse(verification["cloudTest"]["enabled"])
        self.assertEqual(verification["cloudTest"]["signingConfigs"], [{"name": "default"}])
        self.assertFalse(verification["whiteboxEvaluation"]["enabled"])

    def test_named_rules_read_reports_and_do_not_zero_missing_reports(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ui = root / "ui.json"
            cloud = root / "cloudtest-result.json"
            whitebox = root / "whitebox.json"
            ui.write_text(json.dumps({"runs": {"swe": {"devices": [
                {"status": "passed", "testsRun": 2, "failures": 0, "errors": 0},
            ]}}}), encoding="utf-8")
            cloud.write_text(json.dumps({"report": {"summary": {
                "devicePassed": 1, "deviceFailed": 1, "rulePassed": 3, "ruleFailed": 1,
            }}}), encoding="utf-8")
            whitebox.write_text(json.dumps({"totalScore": 87}), encoding="utf-8")
            entries = [{"dimension": "L1", "name": "BooleanScoring"},
                       {"dimension": "L2", "name": "WeightedSummation"},
                       {"dimension": "L3", "name": "ImmediateValue"}]
            validate_scoring(entries, {"UITest": True, "CloudTest": True, "Whitebox": True})
            result = {"ohosTest": {"resultPath": str(ui)},
                      "cloudTest": {"resultPath": str(cloud)},
                      "whitebox": {"resultPath": str(whitebox)}}
            scores = score_case(entries, result)
            self.assertEqual(scores["L1"]["score"], 1.0)
            self.assertEqual(scores["L2"]["score"], 0.625)
            self.assertEqual(scores["L3"]["score"], 87.0)
            cloud.unlink()
            missing = score_case(entries, result)
            self.assertEqual(missing["L2"]["status"], "unavailable")
            self.assertIsNone(missing["L2"]["score"])
            summary = summarize_scores([{"scoring": scores}, {"scoring": missing}], entries)
            self.assertEqual(summary["L2"]["scored"], 1)
            self.assertEqual(summary["L2"]["average"], 0.625)
            html = _case_page({"case": "CaseA", "scoring": scores})
            self.assertIn("BooleanScoring", html)
            report = build_batch_report({"summary": {"batchId": "test", "results": [],
                                                        "harmonyEval": {"scores": summary}},
                                         "generatedAt": "now"})
            self.assertEqual(report["harmonyEval"]["scores"]["L2"]["average"], 0.625)


if __name__ == "__main__":
    unittest.main()

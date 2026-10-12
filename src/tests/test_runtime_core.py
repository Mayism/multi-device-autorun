"""Protocol and configuration checks for Python-owned runtime components."""

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from pyautorun.orchestration.agent import (normalize_agent_targets, normalize_generation_model,
                             resolve_configured_model, server_allows_execution)
from pyautorun.orchestration.config import load_autorun_config
from pyautorun.runtime.opencode import OpenCodeClient, OpenCodeHttpError
from pyautorun.runtime.opencode_installation import resolve_opencode_source, _node_platform, _node_arch
from pyautorun.orchestration.sandbox_copy import copy_project
from pyautorun.orchestration.agent_case_workspace import (agent_case_layout, prepare_agent_case_workspace,
                                             materialize_agent_case_projects)
from pyautorun.runtime.platform import check_configured_emulator_ports, format_emulator_port_conflict
from pyautorun.runtime.usage import aggregate_session_messages, collect_compile_attempts, TokenUsageTracker
from pyautorun.runtime.skill_runtime import discover_runtime_skills, discover_loaded_skills, inspect_skill_workflow
from pyautorun.cloud.cloudtest_poll import poll_existing_task
from pyautorun.cloud.cloudtest_submit import run_cloud_test, apply_signing_overrides, read_app_profile
from pyautorun.devices.json5_lite import parse_loose_json5
from pyautorun.runtime.session_monitor import run_monitored_session, requests_basic_tests_reply, hard_quota_cap
from pyautorun.runtime.opencode_server import OwnedServer, prepare_software_runtime
from pyautorun.orchestration.cases import discover_cases


class AgentConfigTests(unittest.TestCase):
    def test_windows_server_stop_kills_launcher_and_child_tree(self):
        class Process:
            pid = 1234
            returncode = None
            terminated = False

            def poll(self):
                return self.returncode

            def wait(self, _timeout=None):
                return self.returncode

            def terminate(self):
                self.terminated = True
                self.returncode = 1

        process = Process()
        commands = []

        def taskkill(command, **_kwargs):
            commands.append(command)
            process.returncode = 0

        with patch("pyautorun.runtime.opencode_server._is_windows", return_value=True), \
             patch("pyautorun.runtime.opencode_server.subprocess.run", side_effect=taskkill):
            asyncio.run(OwnedServer(None, {}, {}, process=process).stop())
        self.assertEqual(commands, [["taskkill", "/PID", "1234", "/T", "/F"]])
        self.assertFalse(process.terminated)

    def test_target_and_model_normalization(self):
        targets = normalize_agent_targets({"targets": [
            {"id": "hb", "mode": "harmonyBot", "root": "../extensions", "agent": "build-agent"},
            {"id": "se", "mode": "softwareEngineering", "root": "/opt/se"},
        ]}, "/tmp/config")
        self.assertEqual([item["agent"] for item in targets["targets"]], ["build-agent", "build"])
        self.assertEqual(targets["targets"][0]["root"], "/tmp/extensions")
        self.assertTrue(targets["multiple"])
        with self.assertRaisesRegex(ValueError, "execution.providerId"):
            normalize_generation_model({"model": "glm"}, require_provider=True)
        with self.assertRaisesRegex(ValueError, "id 重复"):
            normalize_agent_targets({"targets": [
                {"id": "a", "mode": "harmonyBot", "root": "/a", "agent": "a"},
                {"id": "a", "mode": "softwareEngineering", "root": "/b"},
            ]})

    def test_permission_skill_allowlist(self):
        config = {"permission": {"*": "allow", "skill": {"*": "deny", "good": "allow"}},
                  "agent": {"a": {"permission": {"*": "allow"}}}}
        self.assertTrue(server_allows_execution(config, "a"))
        config["permission"]["bash"] = "ask"
        self.assertFalse(server_allows_execution(config, "a"))

    def test_full_config_path_normalization(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "autorun.json"
            path.write_text(json.dumps({
                "server": {"opencodeSource": {"mode": "harmonyBot", "root": "extensions", "agent": "a"}},
                "execution": {"model": "glm", "outputRoot": "out"},
                "whiteboxEvaluation": {"enabled": True},
            }), encoding="utf-8")
            config = load_autorun_config(path)
            self.assertEqual(config["execution"]["outputRoot"], str(Path(temp) / "out"))
            self.assertEqual(config["whiteboxEvaluation"]["runtime"]["root"], str(Path(temp) / "extensions"))
            self.assertEqual(config["execution"]["generationModel"], {"providerId": "", "modelId": "glm"})

    def test_software_engineering_bundle_resolution(self):
        with tempfile.TemporaryDirectory() as temp:
            resources = Path(temp) / "resources" / "opencode"
            binary = resources / "bin" / _node_platform() / _node_arch() / "opencode"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b"bin")
            (resources / "skills").mkdir()
            (resources / "opencode.json").write_text("{}", encoding="utf-8")
            result = resolve_opencode_source({"mode": "softwareEngineering", "root": temp})
            self.assertEqual(result["opencodeBinPath"], str(binary))
            self.assertEqual(result["assetsDir"], str(resources))
            with self.assertRaisesRegex(ValueError, "exeRelativePath 无效"):
                (resources / "bundled-opencode.json").write_text(json.dumps({
                    "platform": _node_platform(), "arch": _node_arch(), "exeRelativePath": "../escape",
                }), encoding="utf-8")
                resolve_opencode_source({"mode": "softwareEngineering", "root": temp})

    def test_sandbox_copy_remaps_links_and_excludes_build(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "case"
            target = Path(temp) / "sandbox"
            (source / "project").mkdir(parents=True)
            (source / "project" / "main.txt").write_text("source", encoding="utf-8")
            (source / "build").mkdir()
            (source / "build" / "stale").write_text("skip", encoding="utf-8")
            (source / "shortcut").symlink_to("project", target_is_directory=True)
            result = copy_project(source, target)
            self.assertEqual(result, {"linksRemapped": 1})
            self.assertFalse((target / "build").exists())
            self.assertEqual((target / "shortcut" / "main.txt").read_text(encoding="utf-8"), "source")
            self.assertEqual((target / "shortcut").resolve(), (target / "project").resolve())
            (source / "external").symlink_to(Path(temp))
            with self.assertRaisesRegex(ValueError, "拒绝复制"):
                copy_project(source, target)
            with self.assertRaisesRegex(ValueError, "不能互相包含"):
                copy_project(source, Path(temp))

    def test_web_workspace_contains_base_and_web_without_evaluation_file(self):
        with tempfile.TemporaryDirectory() as temp:
            case = Path(temp) / "case"
            (case / "base").mkdir(parents=True)
            (case / "web").mkdir()
            (case / "base" / "app.txt").write_text("base", encoding="utf-8")
            (case / "web" / "page.txt").write_text("web", encoding="utf-8")
            (case / "golden_patch.patch").write_text("hidden", encoding="utf-8")
            info = {"name": "CaseWeb", "platform": "web", "projectName": "base",
                    "projectDir": str(case / "base"), "webProjectDir": str(case / "web")}
            run = Path(temp) / "run"
            layout = agent_case_layout(info, run)
            prepare_agent_case_workspace(info, layout)
            project = Path(layout["projectDir"])
            self.assertEqual((project / "base" / "app.txt").read_text(), "base")
            self.assertEqual((project / "web" / "page.txt").read_text(), "web")
            self.assertFalse((project / "golden_patch.patch").exists())
            (project / "web" / "page.txt").write_text("adapted", encoding="utf-8")
            materialize_agent_case_projects(info, layout, run)
            self.assertEqual((run / "web" / "page.txt").read_text(), "adapted")

    def test_case_discovery_checks_web_and_ohostest_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            case = Path(temp) / "CaseWeb"
            (case / "base").mkdir(parents=True)
            (case / "PROMPT.md").write_text("Build web", encoding="utf-8")
            (case / "metadata.json").write_text(json.dumps({"platform": "web"}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "缺少 web"):
                discover_cases(temp)
            (case / "web").mkdir()
            found = discover_cases(temp)
            self.assertEqual(found["runnable"][0]["platform"], "web")
            with self.assertRaisesRegex(ValueError, "base_project"):
                discover_cases(temp, require_ohostest=True)

    def test_emulator_port_recommendation_skips_reserved_ports(self):
        config = {"devices": [
            {"id": "phone", "startEmulator": True, "hdcPort": 10001},
            {"id": "fold", "startEmulator": True, "hdcPort": 10002},
        ]}
        probe = lambda port, host: port not in (10001, 10002)
        conflicts = check_configured_emulator_ports(config, probe, 10000, 10005)
        self.assertEqual([item["recommendedPort"] for item in conflicts], [10003, 10004])
        self.assertIn("127.0.0.1:10003", format_emulator_port_conflict(conflicts[0]))

    def test_session_usage_deduplicates_messages_and_only_counts_harmony_builds(self):
        first = {"info": {"id": "m1", "tokens": {"input": 10, "output": 2}}}
        latest = {"info": {"id": "m1", "tokens": {"input": 12, "output": 3}}}
        sessions = [{"sessionId": "s", "messages": [first, latest]}]
        self.assertEqual(aggregate_session_messages(sessions)["total"], 15)
        tracker = TokenUsageTracker()
        self.assertTrue(tracker.update("s", first))
        self.assertFalse(tracker.update("s", first))
        self.assertTrue(tracker.update("s", latest))
        self.assertEqual(tracker.total()["input"], 12)
        parts = [
            {"type": "tool", "tool": "bash", "callID": "build", "state": {"status": "completed",
             "input": {"command": "hvigorw assembleHap"}, "metadata": {"exit": 0}}},
            {"type": "tool", "tool": "bash", "callID": "web", "state": {"status": "completed",
             "input": {"command": "npm run build"}, "metadata": {"exit": 0}}},
        ]
        result = collect_compile_attempts([{"sessionId": "s", "messages": [{"parts": parts}]}])
        self.assertEqual((result["attempts"], result["succeeded"]), (1, 1))

    def test_skill_discovery_stays_within_selected_snapshot(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            skill_file = root / "skills" / "harmonyos-ui-multi" / "SKILL.md"
            skill_file.parent.mkdir(parents=True)
            skill_file.write_text("---\nname: harmonyos-ui-multi\n---\nInstructions", encoding="utf-8")
            registered = [{"name": "harmonyos-ui-multi", "location": str(skill_file)}]
            found = discover_runtime_skills(root / "skills", registered)
            self.assertEqual(found, [{"name": "harmonyos-ui-multi", "root": str(skill_file.parent.resolve())}])
            self.assertEqual(discover_loaded_skills(registered), found)
            other = root / "other" / "SKILL.md"
            other.parent.mkdir()
            other.write_text(skill_file.read_text(), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "不属于当前来源快照"):
                discover_runtime_skills(root / "skills", [{"name": "harmonyos-ui-multi", "location": str(other)}])
            project = root / "project"
            project.mkdir()
            runtime = {"oneMulti": {"installer": str(skill_file)}}
            self.assertEqual(inspect_skill_workflow(runtime, project)["status"], "incomplete")

    def test_python_opencode_runtime_copies_private_skills_and_permissions(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            resources = root / "source" / "resources" / "opencode"
            skill = resources / "skills" / "demo" / "SKILL.md"
            skill.parent.mkdir(parents=True)
            skill.write_text("---\nname: demo\n---\n", encoding="utf-8")
            (resources / "opencode.json").write_text(json.dumps({"agent": {"build": {}},
                "provider": {"local": {"models": {"model": {}}}}}), encoding="utf-8")
            deveco = root / "deveco"
            deveco.mkdir()
            config = {"server": {"devecoHome": str(deveco)}, "execution": {"agent": "build"}}
            source = {"resourcesDir": str(resources), "assetsDir": str(resources)}
            runtime = prepare_software_runtime(source, config, root / "runtime", root, "61419")
            copied = Path(runtime["configDir"]) / "skills" / "demo" / "SKILL.md"
            self.assertTrue(copied.is_file())
            self.assertEqual(runtime["toolResources"]["skillNames"], ["demo"])
            generated = json.loads((Path(runtime["configDir"]) / "opencode.json").read_text())
            self.assertEqual(generated["permission"]["skill"], {"*": "deny", "demo": "allow"})
            self.assertIn("无人值守确认策略", generated["agent"]["build"]["prompt"])


class _Handler(BaseHTTPRequestHandler):
    requests = []

    def do_GET(self):
        self._respond()

    def do_POST(self):
        self._respond()

    def _respond(self):
        length = int(self.headers.get("Content-Length", "0"))
        payload = self.rfile.read(length).decode("utf-8") if length else ""
        self.requests.append((self.command, self.path, self.headers.get("x-opencode-directory"), payload))
        parsed = urlsplit(self.path)
        if parsed.path == "/global/health":
            result = {"healthy": True}
        elif parsed.path == "/config":
            result = {"provider": {"static": {"models": {"glm": {}}}}, "agent": {"a": {}}}
        elif parsed.path == "/config/providers":
            result = {"providers": [{"id": "dynamic", "models": {"glm-5.2": {}}}]}
        elif parsed.path == "/error":
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b'{"message":"bad request"}')
            return
        else:
            result = {"path": parsed.path, "directory": parse_qs(parsed.query).get("directory", [""])[0]}
        body = json.dumps(result).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class OpenCodeProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.client = OpenCodeClient(f"http://127.0.0.1:{cls.server.server_port}")

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def test_directory_session_and_model_validation(self):
        async def run():
            self.assertTrue(await self.client.health())
            result = await self.client.create_session("/tmp/project")
            self.assertEqual(result["directory"], "/tmp/project")
            self.assertTrue(await self.client.validate_agent("a"))
            self.assertEqual(await self.client.resolve_model("glm"), {"providerId": "static", "modelId": "glm"})
            model = await resolve_configured_model(self.client, {"provider": {}}, "dynamic", "glm-5.2", "/tmp")
            self.assertEqual(model["providerId"], "dynamic")
        asyncio.run(run())
        method, path, directory, body = _Handler.requests[-4]
        self.assertEqual(method, "POST")
        self.assertEqual(directory, "/tmp/project")
        self.assertEqual(json.loads(body), {})

    def test_http_error_body(self):
        async def run():
            with self.assertRaises(OpenCodeHttpError) as raised:
                await self.client.request("/error")
            self.assertEqual(raised.exception.status, 400)
            self.assertEqual(raised.exception.body, {"message": "bad request"})
        asyncio.run(run())

    def test_python_session_monitor_reaches_terminal_message(self):
        class Client:
            base_url = "http://127.0.0.1:1"

            async def prompt_async(self, *_args):
                return {}

            async def list_messages(self, *_args):
                return [{"info": {"id": "done", "role": "assistant", "finish": "stop",
                                   "tokens": {"input": 1, "output": 2}},
                         "parts": [{"type": "text", "text": "ok"}, {"type": "step-finish"}]}]

            async def list_children(self, *_args):
                return []

            async def list_todos(self, *_args):
                return []

            async def list_questions(self, *_args):
                return []

            async def list_permissions(self, *_args):
                return []

            async def abort_session(self, *_args):
                return {}

        with tempfile.TemporaryDirectory() as temp:
            result = asyncio.run(run_monitored_session(
                Client(), "session", temp, {"parts": [{"type": "text", "text": "work"}]},
                Path(temp) / "events.jsonl", Path(temp) / "polling.jsonl", idle_timeout_sec=5,
                max_runtime_sec=5))
            self.assertEqual(result["output"], "ok")
            self.assertEqual(result["tokenUsage"]["total"], 3)
            self.assertTrue(hard_quota_cap("每周使用上限将在明天重置"))
            self.assertTrue(requests_basic_tests_reply({"parts": [{"type": "text", "text":
                "当前模型未通过图片理解探测，请回复**仅基础测试**"}]}))


class CloudPollTests(unittest.TestCase):
    def test_existing_task_produces_python_report(self):
        class Client:
            def list_task_groups(self):
                return [{"id": 123, "status": 3, "resultStatus": 1, "taskGroupName": "smoke",
                         "categoryList": [24], "taskCount": 1, "processedTestTaskCount": 1}]

            def get_report_apps(self, _id):
                return [{"appInfo": {"appName": "demo"}}]

            def get_overview_result(self, _id):
                return {"categoryResults": [{"ruleInfo": {"passedErrorCount": 2}}]}

            def get_overview_problem(self, _id, _category):
                return []

            def get_report_task_list(self, _id, _category):
                return [{"deviceInfo": {"displayName": "Phone"}, "resultStatus": 1,
                         "useCaseResultList": [{"useCase": "A", "resultStatus": "PASS"}]}]

            def get_dev_report_title(self, _id, _category):
                return []

        with tempfile.TemporaryDirectory() as temp:
            (Path(temp) / "agc-cookie.txt").write_text("test-cookie", encoding="utf-8")
            config = {"__baseDir": temp, "execution": {"outputRoot": temp},
                      "cloudTest": {"teamId": "team", "projectId": "project", "cookieFile": "agc-cookie.txt"}}
            messages = []
            result = poll_existing_task(config, "123", on_log=messages.append, client=Client())
            self.assertEqual(result["status"], "completed")
            report = Path(result["report"]["htmlPath"])
            self.assertTrue(report.is_file())
            self.assertIn("Phone", report.read_text(encoding="utf-8"))
            self.assertTrue((report.parent / "cloudtest-result.json").is_file())

    def test_direct_app_submission_uses_python_transport_and_report(self):
        class Client:
            def refresh_auth(self):
                return {}

            def list_apps(self):
                return []

            def request_upload_url(self, file_name, file_size, sha256):
                self.digest = (file_name, file_size, sha256)
                return {"url": "https://obs.invalid", "headers": {"authorization": "fake"}, "objectId": "obs"}

            def put_object(self, obs, file_path, expected_digest):
                self.uploaded = Path(file_path).read_bytes()
                return True

            def trigger_analyze(self, object_id):
                return {}

            def poll_analyze(self, object_id, timeout_ms, on_progress):
                return {"id": 5, "appName": "Demo", "appVersion": "1", "packageName": "demo",
                        "appType": 1, "geApiLevel": 20}

            def list_business_devices(self, app_type, test_categories, api_levels):
                return [{"type": 1, "typeAlias": "Phone", "alias": "phone", "groupId": 7,
                         "openharmonySdk": 20, "idleDeviceCount": 1}]

            def predict_confirm(self, payload):
                return {"data": {"amountEnough": True}}

            def submit_task(self, payload):
                self.submission = payload
                return "123"

            def list_task_groups(self):
                return [{"id": 123, "status": 3, "resultStatus": 1, "taskCount": 1,
                         "processedTestTaskCount": 1}]

            def get_report_apps(self, _id):
                return []

            def get_overview_result(self, _id):
                return {}

            def get_overview_problem(self, _id, _category):
                return []

            def get_report_task_list(self, _id, _category):
                return []

            def get_dev_report_title(self, _id, _category):
                return []

        with tempfile.TemporaryDirectory() as temp:
            (Path(temp) / "agc-cookie.txt").write_text("test-cookie", encoding="utf-8")
            app = Path(temp) / "demo.app"
            app.write_bytes(b"signed-app")
            config = {"__baseDir": temp, "execution": {"outputRoot": temp},
                      "cloudTest": {"teamId": "team", "projectId": "project", "cookieFile": "agc-cookie.txt"}}
            client = Client()
            result = run_cloud_test(config, app_path=str(app), client=client, on_log=lambda _: None)
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["task"]["taskGroupId"], "123")
            self.assertEqual(client.uploaded, b"signed-app")
            self.assertTrue(Path(result["report"]["htmlPath"]).exists())

    def test_json5_and_signing_override_stay_in_copy(self):
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp)
            (project / "AppScope").mkdir()
            (project / "AppScope" / "app.json5").write_text(
                "{ // app\n app: {bundleName: 'old.name', versionName: '1',}, }", encoding="utf-8")
            (project / "build-profile.json5").write_text(
                "{app: {products: [{name: 'default'}], signingConfigs: []}}", encoding="utf-8")
            self.assertEqual(parse_loose_json5("{a: 'x',}"), {"a": "x"})
            self.assertFalse(read_app_profile(project)["hasSigningConfig"])
            settings = {"bundleName": "new.name", "signingConfigs": [{"name": "release"}]}
            apply_signing_overrides(project, settings, lambda _: None)
            self.assertEqual(read_app_profile(project)["bundleName"], "new.name")
            build = json.loads((project / "build-profile.json5").read_text(encoding="utf-8"))
            self.assertEqual(build["app"]["products"][0]["signingConfig"], "release")


if __name__ == "__main__":
    unittest.main()

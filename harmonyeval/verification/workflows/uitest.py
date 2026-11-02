"""Run device verification and preserve test evidence."""

import asyncio
import json
import shutil
from copy import deepcopy
from pathlib import Path
from harmonyeval.api.registry import verifiers
from harmonyeval.utils.paths import inside
from harmonyeval.utils.io import write_json
from harmonyeval.verification.base import Workflow, result
from harmonyeval.verification.context import command_run, isolated_project


@verifiers.register("UITest")
class UITest(Workflow):
    def requirements(self, config):
        return ["device:" + str(d.get("target") or d["id"]) for d in config.get("devices", [])]

    async def verify(self, case, execution, dependencies, context, config):
        import os
        import sys
        import tempfile
        env = context["env"]
        home = Path(config.get("deveco_home") or env.get("DEVECO_HOME", "/missing-deveco"))
        home = home / "Contents" if (home / "Contents").exists() else home
        sdk = Path(env.get("DEVECO_SDK_HOME", str(home / "sdk")))
        suffix = ".bat" if os.name == "nt" else ""
        paths = {"hvigorw": str(home / f"tools/hvigor/bin/hvigorw{suffix}"),
                 "ohpm": str(home / f"tools/ohpm/bin/ohpm{suffix}"),
                 "hdc": str(sdk / "default/openharmony/toolchains" / ("hdc.exe" if os.name == "nt" else "hdc")),
                 "emulatorBin": str(home / "tools/emulator" / ("emulator.exe" if os.name == "nt" else "emulator")),
                 "emulatorDeployedDir": config.get("emulator_deployed_dir", "")}
        paths.update(config.get("paths", {}))
        if env.get("FLUTTER_HOME"):
            paths["flutter"] = env["FLUTTER_HOME"]
        devices = [{"id": d["id"], "name": d.get("profile", d["id"]), "profile": d.get("profile", ""),
                    "target": d["target"], "hdcPort": d.get("hdc_port", 7035),
                    "startEmulator": d.get("start_emulator", False), **d} for d in config.get("devices", [])]
        if not devices:
            return result(config, "unavailable", error="UITest需要devices设备配置")
        machine = {"paths": paths, "devices": devices, "timeoutMs": config.get("timeout", 120) * 1000,
                   **config.get("machine", {})}
        root = Path(context["output"])
        private = Path(tempfile.mkdtemp(prefix="harmony-eval-machine-"))
        context["temporary_projects"].append(str(private))
        machine_path = private / "machine.json"
        write_json(machine_path, machine)
        if case.metadata.get("native"):
            case_root = Path(tempfile.mkdtemp(prefix="harmony-eval-uitest-"))
            context["temporary_projects"].append(str(case_root))
            meta = deepcopy(case.metadata["native"])
            meta.update({"case_id": case.case_id, "base_project": "base"})
            project = case_root / "base"
            await asyncio.to_thread(shutil.copytree, execution.project, project,
                                    ignore=shutil.ignore_patterns(".git", "node_modules", "oh_modules", "build", ".hvigor"))
            if meta.get("platform") == "web":
                web = Path(execution.workspace) / "web"
                if not web.is_dir():
                    return result(config, "unavailable", error="Web用例缺少生成的web工程")
                shutil.copytree(web, case_root / "web", ignore=shutil.ignore_patterns("node_modules", "build"))
            for key in ("test_patch", "golden_patch"):
                relative = meta.get(key)
                if relative:
                    target = inside(case_root, relative)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(inside(case.root, relative, exists=True), target)
            write_json(case_root / "metadata.json", meta)
            await command_run([sys.executable, "-m", "harmonyeval.integrations.uitest.ohostest_case", "--case", str(case_root),
                               "--out", str(root), "--machine-config", str(machine_path), "--run", "swe"],
                              project, context, "uitest-runner", config.get("timeout", 7200))
            raw = json.loads((root / "result.json").read_text())
            raw = raw.get("runs", {}).get("swe", raw)
        else:
            project = await isolated_project(execution, context)
            tests = case.expected.get("tests")
            if tests:
                shutil.copytree(inside(case.root, tests, exists=True), project, dirs_exist_ok=True)
            await command_run([sys.executable, "-m", "harmonyeval.integrations.uitest.ohostest_matrix", "--project", str(project),
                               "--machine-config", str(machine_path), "--out", str(root / "uitest.json")],
                              project, context, "uitest-runner", config.get("timeout", 7200))
            raw = json.loads((root / "uitest.json").read_text())
        build_status = raw.get("build", {}).get("status")
        if build_status in ("blocked", None):
            return result(config, "unavailable", error="UITest基础设施或工程准备失败", evidence=[raw])
        rows = raw.get("devices", [])
        tests = sum(d.get("testsRun", 0) for d in rows)
        passes = sum(d.get("passes", 0) for d in rows)
        build_passed = build_status in ("passed", "completed", "success")
        metrics = {"build_passed": build_passed, "tests_run": tests, "passes": passes,
                   "pass_rate": passes / tests if tests else None,
                   "all_tests_passed": tests > 0 and passes == tests and all(d.get("status") in ("passed", "completed") for d in rows)}
        if build_passed and (not tests or any(not d.get("testsRun") and d.get("status") not in ("passed", "completed") for d in rows)):
            return result(config, "unavailable", metrics=metrics, error="设备或测试执行未完成，不能把缺失的断言结果计为零分",
                          evidence=[str(root / "result.json" if case.metadata.get("native") else root / "uitest.json")])
        return result(config, "completed" if build_passed else "failed", metrics=metrics,
                      evidence=[str(root / "result.json" if case.metadata.get("native") else root / "uitest.json")])

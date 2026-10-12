"""UITest verifier adapter for the existing ohosTest runner."""

import asyncio
from pathlib import Path

from pyautorun.devices.ohostest import normalize_config as normalize_ohostest_config
from pyautorun.reporting.failure_analysis import analyze_uitest_failures
from pyautorun.harmony_eval.verification import Verifier, register_verifier


DEFAULT_DEVICES = [
    {"id": "phone", "profile": "Pura 90 Pro", "target": "127.0.0.1:15001", "hdcPort": 15001,
     "startEmulator": True},
    {"id": "foldable", "profile": "Mate X7", "target": "127.0.0.1:15005", "hdcPort": 15005,
     "startEmulator": True},
    {"id": "tablet", "profile": "MatePad Pro 13", "target": "127.0.0.1:15008", "hdcPort": 15008,
     "startEmulator": True},
]


def _path(base, value, field):
    if not value or not isinstance(value, str):
        raise ValueError(f"{field} 必须是路径")
    path = Path(value).expanduser()
    return str((path if path.is_absolute() else base / path).resolve())


def deveco_contents(home):
    """Accept either the DevEco application root or its Contents directory."""
    root = Path(home)
    return root / "Contents" if (root / "Contents").is_dir() else root


@register_verifier("UITest")
class UITestVerifier(Verifier):
    legacy_config_key = "ohosTest"
    legacy_result_key = "ohosTest"
    affects_case_status = True
    requires_ohostest_case = True

    @classmethod
    def normalize_task_config(cls, item, base_dir, shared):
        home = _path(base_dir, item.get("deveco_home"), "UITest.deveco_home")
        contents = deveco_contents(home)
        if shared.get("devecoHome") and shared["devecoHome"] != str(contents):
            raise ValueError("UITest 和 CloudTest 的 deveco_home 必须一致")
        shared["devecoHome"] = str(contents)
        paths = {"hvigorw": str(contents / "tools/hvigor/bin/hvigorw"),
                 "ohpm": str(contents / "tools/ohpm/bin/ohpm"),
                 "hdc": str(contents / "sdk/default/openharmony/toolchains/hdc"),
                 "emulatorBin": str(contents / "tools/emulator/Emulator"),
                 "emulatorDeployedDir": str(Path(item.get("emulator_deployed_dir") or
                                                 "~/.Huawei/Emulator/deployed").expanduser()),
                 "flutter": str(item.get("flutter_home") or "")}
        return {"paths": paths, "devices": item.get("devices") or DEFAULT_DEVICES,
                "timeoutSec": int(item.get("timeout_sec") or 7200)}

    async def prepare(self, config, workspace, dependencies):
        self.settings = normalize_ohostest_config({"config": config})
        self.runner = dependencies.get("ohostest_runner")
        if self.runner is None:
            raise RuntimeError("Python ohosTest Runner 尚未配置，不能执行启用设备测试的批次")
        self.lock = asyncio.Lock()
        self.analysis_lock = asyncio.Lock()

    async def verify(self, context):
        async with self.lock:
            outcome = await self.runner(context["case_info"], context["agent_result"],
                                        self.settings, context["root"])
        if outcome.get("resultPath"):
            async with self.analysis_lock:
                analysis = await analyze_uitest_failures(context["server"].client, context["model"],
                                                         context["case_info"], context["agent_result"], outcome)
            if analysis:
                outcome = {**outcome, "failureAnalysis": analysis}
        return outcome

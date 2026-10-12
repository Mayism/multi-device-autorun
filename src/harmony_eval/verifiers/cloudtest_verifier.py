"""AGC CloudTest verifier adapter."""

import asyncio
from pathlib import Path

from pyautorun.cloud.cloudtest import load_config as load_cloud_config
from pyautorun.cloud.cloudtest_submit import finish_cloud_test_polling, submit_cloud_test_for_project
from pyautorun.harmony_eval.verification import Verifier, register_verifier

from .uitest_verifier import _path, deveco_contents


@register_verifier("CloudTest")
class CloudTestVerifier(Verifier):
    legacy_config_key = "cloudTest"
    legacy_result_key = "cloudTest"
    affects_case_status = True
    requires_cloud_stage = True

    @classmethod
    def normalize_task_config(cls, item, base_dir, shared):
        config = {key: value for key, value in item.items() if key not in ("id", "type", "enabled")}
        cloud_deveco = config.pop("deveco_home", None)
        if cloud_deveco:
            contents = str(deveco_contents(_path(base_dir, cloud_deveco, "CloudTest.deveco_home")))
            if shared.get("devecoHome") and shared["devecoHome"] != contents:
                raise ValueError("UITest 和 CloudTest 的 deveco_home 必须一致")
            shared["devecoHome"] = contents
        categories = config.pop("test_categories", None)
        if categories is None and config.pop("test_category", None):
            raise ValueError("CloudTest.test_category 请改为 test_categories，提供 AGC 数字 category 列表")
        if categories is not None and (not isinstance(categories, list) or not categories or
                                       any(not isinstance(category, dict) or
                                           not isinstance(category.get("category"), int)
                                           for category in categories)):
            raise ValueError("CloudTest.test_categories 必须是含数字 category 的非空对象列表")
        return {**config, "testCategories": categories or [{"category": 24, "timeSpan": 60}]}

    async def prepare(self, config, workspace, dependencies):
        self.config = config
        self.settings = load_cloud_config({"config": config})
        self.lock = asyncio.Lock()

    async def verify(self, context):
        case_info = context["case_info"]
        agent_result = context["agent_result"]
        out_dir = str(Path(agent_result["resultPath"]).parent / "cloudtest")
        loop = asyncio.get_running_loop()
        progress = context["progress"]
        log = lambda message: loop.call_soon_threadsafe(progress, case_info["name"], f"云测试：{message}")
        try:
            async with self.lock:
                submission = await asyncio.to_thread(
                    submit_cloud_test_for_project, self.config, agent_result.get("buildProjectDir") or
                    agent_result.get("projectDir") or "", "", case_info["name"], "", case_info["name"],
                    out_dir, log, None, self.settings)
            return await asyncio.to_thread(finish_cloud_test_polling, submission, log)
        except Exception as error:
            return {"status": "failed", "error": str(error), "outputDir": out_dir}

    def report_path(self, outcome):
        if outcome.get("resultPath"):
            return str(outcome["resultPath"])
        return str(Path(outcome["outputDir"]) / "cloudtest-result.json") if outcome.get("outputDir") else ""

    def legacy_result(self, outcome):
        task = outcome.get("task") or {}
        return {"status": outcome.get("status") or "failed", "taskGroupId": task.get("taskGroupId") or "",
                "taskName": task.get("taskName") or "", "error": outcome.get("error") or "",
                "outputDir": outcome.get("outputDir") or "", "resultPath": outcome.get("resultPath") or ""}

"""Submit AGC verification and normalize cloud-test evidence."""

import asyncio
import json
from pathlib import Path
from harmonyeval.api.registry import verifiers
from harmonyeval.verification.workflows.command import CommandWorkflow
from harmonyeval.verification.base import Workflow, result
from harmonyeval.verification.context import isolated_project


@verifiers.register("CloudTest")
class CloudTest(Workflow):
    def requirements(self, config):
        return ["agc-cloud-submit"]

    async def verify(self, case, execution, dependencies, context, config):
        from harmonyeval.integrations.agc.cloudtest_submit import submit_cloud_test_for_project, finish_cloud_test_polling
        import os
        categories = config.get("test_categories")
        if config.get("test_category"):
            mapping = config.get("category_mapping", {})
            labels = [s.strip() for s in config["test_category"].split(",")]
            if any(label not in mapping for label in labels):
                return result(config, "unavailable", error="CloudTest文本类别需显式category_mapping，对应实际AGC服务版本")
            categories = [mapping[label] for label in labels]
        env = context["env"]
        server = {"sdkHome": env.get("DEVECO_SDK_HOME", ""),
                  "javaHome": env.get("JAVA_HOME", "")}
        if env.get("DEVECO_HOME"):
            home = Path(env["DEVECO_HOME"])
            suffix = ".bat" if os.name == "nt" else ""
            server.update({"hvigorw": str(home / f"tools/hvigor/bin/hvigorw{suffix}"),
                           "ohpm": str(home / f"tools/ohpm/bin/ohpm{suffix}")})
        raw_config = {"__baseDir": context["task"]["base_dir"],
                      "cloudTest": {**config, "enabled": True},
                      "server": server,
                      "execution": {"outputRoot": context["output"]}}
        if categories:
            raw_config["cloudTest"]["testCategories"] = [{"category": int(c), "timeSpan": 60} for c in categories]
        project = await isolated_project(execution, context)
        submission = await asyncio.to_thread(submit_cloud_test_for_project, raw_config, str(project), "", case.case_id,
                                               "", case.case_id, context["output"], lambda _: None)
        raw = await asyncio.to_thread(finish_cloud_test_polling, submission, lambda _: None)
        if raw.get("status") in ("timed_out", "interrupted") or raw.get("error"):
            return result(config, "unavailable", error=raw.get("error") or raw["status"])
        summary = raw.get("report", {}).get("summary")
        if not summary or not summary.get("deviceCount"):
            return result(config, "unavailable", error="云任务已结束，但缺少实际设备与规则报告")
        total, passed = summary["deviceCount"], summary.get("devicePassed", 0)
        metrics = {"passed": passed == total and summary.get("ruleFailed", 0) == 0 and summary.get("issueCount", 0) == 0,
                   "pass_rate": passed / total, "device_count": total, "device_passed": passed,
                   "rule_failed": summary.get("ruleFailed", 0), "issue_count": summary.get("issueCount", 0)}
        return result(config, metrics=metrics,
                      evidence=[str(Path(context["output"]) / "cloudtest-result.json")])


@verifiers.register("AGCDetection")
class AGCDetection(Workflow):
    """Service protocol is explicit; no invented compatibility with CloudTest."""
    @staticmethod
    def validate(config):
        if not config.get("command") and not config.get("http_url"):
            raise ValueError("AGCDetection需要command或http_url及response.answer_path服务协议配置")

    async def verify(self, case, execution, dependencies, context, config):
        if config.get("command"):
            return await CommandWorkflow().verify(case, execution, dependencies, context, config)
        from harmonyeval.agent.engines.http_protocols import call_http
        data = await asyncio.to_thread(call_http, {"timeout": 120, **config}, case.public())
        raw = json.loads(data["answer"])
        if not isinstance(raw.get("passed"), bool):
            raise ValueError("AGCDetection结果必须有passed布尔值")
        return result(config, metrics=raw)

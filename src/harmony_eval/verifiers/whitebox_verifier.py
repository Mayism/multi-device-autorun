"""Whitebox verifier adapter with its own judge runtime lifecycle."""

import asyncio
from copy import deepcopy
from pathlib import Path

from pyautorun.harmony_eval.verification import Verifier, register_verifier
from pyautorun.runtime.opencode_installation import resolve_opencode_source
from pyautorun.runtime.opencode_server import start_server
from pyautorun.whitebox_eval.runtime.adapter import WhiteboxEvaluator, prepare_whitebox_input, resolve_judge_runtime


@register_verifier("Whitebox", "WhiteboxEvaluation", "LLM_judge")
class WhiteboxVerifier(Verifier):
    legacy_config_key = "whiteboxEvaluation"
    legacy_result_key = "whitebox"
    affects_case_status = False
    retain_original = True

    @classmethod
    def normalize_task_config(cls, item, base_dir, shared):
        if item.get("prompt_path"):
            raise ValueError("当前白盒评价沿用原有内置提示词，不支持 LLM_judge.prompt_path")
        return {**{key: value for key, value in item.items() if key not in ("id", "type", "enabled")},
                "runtime": {"source": "harmonyBot"}}

    async def prepare(self, config, workspace, dependencies):
        self.config = config
        override = dependencies.get("whitebox_evaluator")
        if override is not None:
            self.evaluator = override
            return
        whitebox = config["whiteboxEvaluation"]
        source = resolve_opencode_source({"mode": "harmonyBot", "root": whitebox["runtime"]["root"]})
        discovery = deepcopy(config)
        discovery["server"]["opencodeSource"] = {"mode": "harmonyBot",
                                                  "root": source["installation"]["extensionDir"]}
        discovery["server"]["runtimeRoot"] = str(Path(whitebox["runtimeRoot"]) / "provider-discovery")
        discovery["execution"]["agent"] = "harmonyos-multi-device"
        server = None
        try:
            server = await start_server(discovery, workspace, reuse_existing=False)
            judge = await resolve_judge_runtime(server.client, server.server_config,
                                                whitebox["judge"], config["execution"]["generationModel"],
                                                str(workspace))
            self.evaluator = WhiteboxEvaluator(whitebox, judge, source["opencodeBinPath"],
                                               Path(__file__).resolve().parents[3])
        finally:
            if server:
                await server.stop()

    def should_run(self, agent_result):
        return bool(agent_result.get("projectDir"))

    async def verify(self, context):
        try:
            task = await asyncio.to_thread(prepare_whitebox_input, context["run_id"], context["case_info"],
                                           context["agent_result"], context["execution"],
                                           self.config["whiteboxEvaluation"])
            return await self.evaluator.schedule(task)
        except Exception as error:
            return {"status": "failed", "error": str(error), "judge": self.evaluator.judge}

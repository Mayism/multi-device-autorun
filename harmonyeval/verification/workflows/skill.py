"""Run an independent grading Skill and validate its structured output."""

import asyncio
import json
import re
from copy import deepcopy
from pathlib import Path
from harmonyeval.api.registry import verifiers
from harmonyeval.verification.base import Workflow, result
from harmonyeval.verification.context import isolated_project


@verifiers.register("SkillVerifier")
class SkillVerifier(Workflow):
    schema = {"type": "object", "required": ["skill_path", "model"]}

    async def verify(self, case, execution, dependencies, context, config):
        from harmonyeval.api.registry import targets, executors
        from harmonyeval.models.compatibility import evalscope_model, close_model
        import tempfile
        task = deepcopy(context["task"])
        # The independent judge uses the same capabilities in every experiment.
        task.pop("experiment", None)
        task.pop("experiments", None)
        task["target"] = {"type": "skills", "dir": str(Path(config["skill_path"]).resolve())}
        task["active"]["execution"] = {"engine": "opencode", "agent_name": config.get("agent_name", "build"),
                                        "model": config["model"], "timeout": config.get("timeout", 300),
                                        "idle_timeout": 120, "opencode": {"skills": [{"path": task["target"]["dir"], "activation": "required"}]}}
        project = await isolated_project(execution, context)
        with tempfile.TemporaryDirectory(prefix="harmony-eval-skill-judge-") as runtime:
            target = await asyncio.to_thread(targets.get("skills")().prepare, task, runtime)
            judge_model = evalscope_model(config["model"])
            try:
                judge = await executors.get("opencode")().execute(
                    {"case_id": case.case_id, "question": "独立评价当前工程，勿修改业务代码。任务要求：" + case.question +
                     '\n只返回JSON，格式{"metrics":{},"dimensions":[],"findings":[]}。'},
                    target, {"task": task, "workspace": str(project), "output": context["output"], "model": judge_model,
                             "cancel_event": context.get("cancel_event")})
            finally:
                await close_model(judge_model)
        if judge.status != "completed":
            return result(config, "unavailable", error=judge.error)
        raw = json.loads(re.sub(r"^```(?:json)?\s*|\s*```$", "", judge.answer.strip()))
        from jsonschema import validate
        validate(raw, config.get("result_schema", {"type": "object", "required": ["metrics"],
                                                   "properties": {"metrics": {"type": "object"}}}))
        return result(config, metrics=raw["metrics"], dimensions=raw.get("dimensions", []), findings=raw.get("findings", []))

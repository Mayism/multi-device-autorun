"""Validate an isolated target before creating Agent sessions."""

import asyncio
from copy import deepcopy
from pathlib import Path
import time

from .agent import resolve_configured_model, server_allows_execution
from .cases import discover_cases
from .cloudtest import load_config as load_cloudtest_config
from .interaction import has_agent_session_policy
from .ohostest import normalize_config as normalize_ohostest_config
from .opencode_server import start_server
from .skill_runtime import prepare_agent_skill_runtime


async def wait_for_skills(client, directory, timeout_sec=180):
    deadline = time.monotonic() + timeout_sec
    last_error = None
    while time.monotonic() < deadline:
        try:
            return await client.list_skills(directory, min(30, max(1, int(deadline - time.monotonic()))))
        except Exception as error:
            last_error = error
            status = getattr(error, "status", 0)
            if status and status not in (408, 429) and status < 500:
                raise
        await asyncio.sleep(2)
    raise TimeoutError(f"OpenCode Server Skill 加载超时（{timeout_sec} 秒）；最后一次错误: {last_error}")


async def validate_server_config(client, execution, server_config, source_mode):
    agent = execution["agent"]
    if source_mode == "softwareEngineering":
        if not server_allows_execution(server_config, agent):
            raise ValueError(f"OpenCode Server 未对 Agent {agent} 启用运行权限（Skill 来源白名单除外）")
        if not has_agent_session_policy(server_config, agent):
            raise ValueError(f"OpenCode Server 未为 Agent {agent} 注入无人值守会话策略")
    elif agent not in (server_config.get("agent") or {}):
        raise ValueError(f"Server 未配置 Agent: {agent}")
    if agent == "harmonyos-multi-device":
        prompt = str(((server_config.get("agent") or {}).get(agent) or {}).get("prompt") or "")
        if "harmonyos-ui-multi" not in prompt:
            raise ValueError("harmonyos-multi-device 插件未正确加载：运行时 Agent prompt 缺少一多适配工作流指令")
        skills = await wait_for_skills(client, execution["casesRoot"])
        names = {str(item.get("name") or item.get("id") or "") for item in skills if isinstance(item, dict)}
        if "harmonyos-ui-multi" not in names:
            raise ValueError("harmonyos-multi-device 关键 Skill 未注册: harmonyos-ui-multi")
    return await resolve_configured_model(client, server_config, execution.get("providerId") or "",
                                          execution["model"], execution["casesRoot"])


async def check_environment(config, on_log=print):
    failures = []
    targets = config["server"]["opencodeTargets"]["targets"]
    ohos = normalize_ohostest_config({"config": config})
    try:
        cloud = load_cloudtest_config({"config": config})
    except Exception as error:
        cloud = {"enabled": False}
        if (config.get("cloudTest") or {}).get("enabled") is not False:
            failures.append(f"云测试：{error}")
    discovered = discover_cases(config["execution"]["casesRoot"], ohos["enabled"])
    checks = []
    for target in targets:
        target_config = deepcopy(config)
        target_config["server"]["opencodeSource"] = dict(target)
        target_config["execution"]["agent"] = target["agent"]
        runtime_root = Path(config["server"]["runtimeRoot"]) / "checks" / target["id"]
        target_config["server"]["runtimeRoot"] = str(runtime_root)
        workspace = runtime_root / "workspace"
        workspace.mkdir(parents=True, exist_ok=True)
        server = None
        try:
            server = await start_server(target_config, workspace, reuse_existing=False, log=on_log)
            model = await validate_server_config(server.client, target_config["execution"],
                                                 server.server_config, target["mode"])
            skills = await wait_for_skills(server.client, str(workspace))
            runtime = prepare_agent_skill_runtime(server.tool_resources, skills,
                                                  target["agent"], target["mode"])
            checks.append({"target": target["id"], "model": model, "skills": runtime["skills"],
                           "caseCount": len(discovered["runnable"])})
            on_log(f"环境检查：通过；Agent={target['agent']}；模型={model['providerId']}/{model['modelId']}；"
                   f"可执行用例={len(discovered['runnable'])}")
        except Exception as error:
            failures.append(f"{target['label']}：{error}")
            on_log(f"环境检查：失败；{target['label']}：{error}")
        finally:
            if server:
                await server.stop()
    return {"checked": not failures, "failures": failures, "targets": checks,
            "caseCount": len(discovered["runnable"]), "skippedCases": discovered["skipped"],
            "ohosTest": ohos, "cloudTest": cloud}

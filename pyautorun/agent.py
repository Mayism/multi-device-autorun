"""Agent target, model and permission rules for the Python runtime."""

from pathlib import Path
import os
import re


def _text(value):
    return "" if value is None else str(value).strip()


def normalize_agent_targets(source, base_dir=None):
    if not isinstance(source, dict):
        raise ValueError("缺少 server.opencodeSource 配置")
    has_targets = isinstance(source.get("targets"), list)
    raw_targets = source["targets"] if has_targets else [source]
    if not raw_targets:
        raise ValueError("server.opencodeSource.targets 不能为空")
    multiple = len(raw_targets) > 1
    targets = []
    for index, item in enumerate(raw_targets):
        if not isinstance(item, dict):
            raise ValueError(f"server.opencodeSource.targets[{index}] 必须为对象")
        mode = _text(item.get("mode"))
        if mode not in ("harmonyBot", "softwareEngineering"):
            raise ValueError(f"OpenCode 来源模式仅支持 harmonyBot 或 softwareEngineering: {mode or '<empty>'}")
        root = _text(item.get("root"))
        if not root:
            raise ValueError(f"Agent 目标 {item.get('id') or mode} 缺少 root")
        identifier = _text(item.get("id") or mode)
        if not identifier or len(identifier) > 120 or not re.fullmatch(r"[0-9A-Za-z._-]+", identifier):
            raise ValueError(f"Agent 目标 id 只能包含字母、数字、点、下划线和连字符: {identifier or '<empty>'}")
        if multiple and not _text(item.get("id")):
            raise ValueError(f"多 Agent 配置必须为每个 target 显式设置唯一 id（缺失位置: targets[{index}]）")
        targets.append({
            "id": identifier,
            "label": _text(item.get("label")) or identifier,
            "mode": mode,
            "root": os.path.abspath(os.path.join(str(base_dir or Path.cwd()), root)),
            "agent": "build" if mode == "softwareEngineering" else _text(item.get("agent")),
        })
    seen = set()
    for target in targets:
        if target["id"] in seen:
            raise ValueError(f"Agent 目标 id 重复: {target['id']}")
        seen.add(target["id"])
        if not target["agent"]:
            raise ValueError(f"Agent 目标 {target['id']} 未配置 agent")
    return {"targets": targets, "multiple": multiple, "legacy": not has_targets}


def normalize_generation_model(execution=None, require_provider=False):
    execution = execution or {}
    model = _text(execution.get("modelId") or execution.get("model"))
    old_model = _text(execution.get("model"))
    new_model = _text(execution.get("modelId"))
    if old_model and new_model and old_model != new_model:
        raise ValueError(f"execution.model 与 execution.modelId 不一致: {execution['model']} / {execution['modelId']}")
    if not model:
        raise ValueError("未配置 execution.model（或 execution.modelId）")
    provider_id = _text(execution.get("providerId"))
    if require_provider and not provider_id:
        raise ValueError("多 Agent 对比必须配置 execution.providerId，以保证所有 Agent 使用同一 Provider/模型")
    return {"providerId": provider_id, "modelId": model}


def _model_ids(provider):
    models = (provider or {}).get("models") or {}
    if isinstance(models, list):
        return [str(model.get("id") or "") if isinstance(model, dict) else str(model) for model in models]
    return list(models) if isinstance(models, dict) else []


def _provider_list(value):
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        if isinstance(value.get("providers"), list):
            return value["providers"]
        data = value.get("data")
        if isinstance(data, dict) and isinstance(data.get("providers"), list):
            return data["providers"]
    return []


async def resolve_configured_model(client, config, provider_id, model_id, directory=""):
    static_providers = (config or {}).get("provider") or {}
    static_matches = [key for key, provider in static_providers.items() if model_id in _model_ids(provider)]
    try:
        runtime_providers = _provider_list(await client.get_providers(directory, 30))
    except Exception:
        runtime_providers = []  # Older OpenCode versions lack this endpoint.
    runtime_matches = [str(provider.get("id")) for provider in runtime_providers
                       if isinstance(provider, dict) and provider.get("id") and model_id in _model_ids(provider)]
    if provider_id:
        runtime_provider = next((item for item in runtime_providers if isinstance(item, dict)
                                 and item.get("id") == provider_id), None)
        if provider_id not in static_providers and runtime_provider is None:
            raise ValueError(f"Server 未配置指定 Provider: {provider_id}")
        if provider_id not in static_matches and provider_id not in runtime_matches:
            available = list(dict.fromkeys([*_model_ids(static_providers.get(provider_id)),
                                            *_model_ids(runtime_provider)]))
            hint = f"（可用模型: {'、'.join(available)}）" if available else ""
            raise ValueError(f"Server Provider {provider_id} 未配置模型: {model_id}{hint}")
        return {"providerId": provider_id, "modelId": model_id}
    matches = list(dict.fromkeys([*static_matches, *runtime_matches]))
    if len(matches) == 1:
        return {"providerId": matches[0], "modelId": model_id}
    if matches:
        raise ValueError(f"模型 {model_id} 同时存在于多个 Provider（{', '.join(matches)}），请配置 execution.providerId")
    raise ValueError(f"Server 未配置模型: {model_id}")


def permission_policy_allows_everything(policy):
    return _permission_allowed(policy, ignore_skill=False)


def permission_policy_allows_execution(policy):
    return _permission_allowed(policy, ignore_skill=True)


def _permission_allowed(policy, ignore_skill):
    if policy == "allow":
        return True
    if not isinstance(policy, dict) or policy.get("*") != "allow":
        return False
    stack = [policy]
    while stack:
        current = stack.pop()
        for key, value in current.items():
            if ignore_skill and current is policy and key == "skill":
                continue
            if isinstance(value, dict):
                stack.append(value)
            elif value in ("ask", "deny"):
                return False
    return True


def server_allows_execution(config, agent_name=""):
    config = config or {}
    if not permission_policy_allows_execution(config.get("permission")):
        return False
    agent = (config.get("agent") or {}).get(agent_name) or {}
    return "permission" not in agent or permission_policy_allows_execution(agent["permission"])


def server_allows_everything(config, agent_name=""):
    config = config or {}
    if not permission_policy_allows_everything(config.get("permission")):
        return False
    agent = (config.get("agent") or {}).get(agent_name) or {}
    return "permission" not in agent or permission_policy_allows_everything(agent["permission"])


def force_allow_everything(config, allowed_skills=None):
    config = config if isinstance(config, dict) else {}

    def policy():
        return {"*": "allow", "skill": {"*": "deny", **{name: "allow" for name in sorted(set(allowed_skills))}}}

    config["permission"] = policy() if allowed_skills is not None else "allow"
    agents = config.get("agent")
    if isinstance(agents, dict):
        for name, agent in agents.items():
            agent = agent if isinstance(agent, dict) else {}
            agent["permission"] = policy() if allowed_skills is not None else {"*": "allow"}
            agents[name] = agent
    return config

"""Whitebox Autorun configuration and judge-provider selection."""

import os

from .batch_report import _numeric, _obj, _list, _truthy


def _fallback(*values):
    return next((value for value in values if _truthy(value)), values[-1])


def _text(value):
    if isinstance(value, bool):
        return str(value).lower()
    return str(value)


def _positive_integer(value, default):
    parsed = _numeric(value)
    return int(parsed) if parsed is not None and parsed > 0 and float(parsed).is_integer() else default


def normalize_config(payload):
    config = _obj(payload.get("raw"))
    judge = _obj(config.get("judge"))
    runtime = _obj(config.get("runtime"))
    concurrency = _positive_integer(config.get("concurrency"), 2)
    failure_policy = _text(_fallback(config.get("failurePolicy"), "record_only"))
    base_port = _positive_integer(judge.get("basePort"), 62400)
    runtime_source = _text(_fallback(runtime.get("source"), "harmonyBot")).strip()
    if failure_policy != "record_only":
        raise ValueError(f"whiteboxEvaluation.failurePolicy 仅支持 record_only，当前为 {failure_policy}")
    if runtime_source != "harmonyBot":
        raise ValueError("whiteboxEvaluation.runtime.source 仅支持 harmonyBot，当前为 "
                         + (runtime_source or "<empty>"))
    if base_port + concurrency - 1 > 65535:
        raise ValueError("whiteboxEvaluation.judge.basePort 与 concurrency 组合超出可用端口范围")
    return {
        "enabled": config.get("enabled") is True,
        "concurrency": concurrency,
        "timeoutSec": _positive_integer(config.get("timeoutSec"), 1800),
        "failurePolicy": failure_policy,
        "prompt": {"includeAdditionalPrompt": _obj(config.get("prompt")).get("includeAdditionalPrompt") is not False},
        "judge": {"providerId": _text(_fallback(judge.get("providerId"), "")).strip(),
                  "modelId": _text(_fallback(judge.get("modelId"), "")).strip(),
                  "basePort": base_port},
        "runtime": {"source": "harmonyBot", "root": _text(_fallback(runtime.get("root"), "")).strip()},
        "officialLinter": {"enabled": _obj(config.get("officialLinter")).get("enabled") is True},
        "hvigorBuildCheck": {"enabled": _obj(config.get("hvigorBuildCheck")).get("enabled") is True},
        "runtimeRoot": os.path.normpath(os.path.join(payload["outputRoot"], "_runtime", "whitebox")),
    }


def bind_runtime(payload):
    config = _obj(payload.get("config"))
    runtime = _obj(config.get("runtime"))
    configured_root = _text(_fallback(runtime.get("root"), "")).strip()
    target = next((_obj(item) for item in _list(payload.get("targets"))
                   if _obj(item).get("mode") == "harmonyBot"), {})
    root = (os.path.abspath(os.path.join(payload["baseDir"], configured_root)) if configured_root
            else _text(_fallback(target.get("root"), "")).strip())
    if _truthy(config.get("enabled")) and not root:
        raise ValueError("白盒评价统一使用 HarmonyBot OpenCode，但未配置 HarmonyBot 来源；"
                         "请在 server.opencodeSource.targets 中加入 mode=harmonyBot，"
                         "或配置 whiteboxEvaluation.runtime.root")
    return {**config, "runtime": {"source": "harmonyBot", "root": root}}


def _provider_models(provider):
    models = _obj(provider).get("models")
    if isinstance(models, list):
        result = {}
        for model in models:
            model_obj = _obj(model)
            model_id = _text(_fallback(model_obj.get("id"), model, ""))
            if model_id:
                result[model_id] = model
        return result
    return _obj(models)


def resolve_judge(payload):
    static_providers = _obj(_obj(payload.get("serverConfig")).get("provider"))
    runtime_providers = [_obj(item) for item in _list(payload.get("runtimeProviders"))]
    judge = _obj(payload.get("judge"))
    generation = _obj(payload.get("generationModel"))
    requested_id = _text(_fallback(judge.get("providerId"), generation.get("providerId"), "")).strip()
    model_id = _text(_fallback(judge.get("modelId"), generation.get("modelId"), "")).strip()
    if not model_id:
        raise ValueError("无法解析白盒裁判模型名称")

    provider_ids = list(dict.fromkeys([*static_providers,
                                       *[_text(item.get("id")).strip() for item in runtime_providers
                                         if _truthy(item.get("id"))]]))
    matches = []
    for provider_id in provider_ids:
        runtime = next((item for item in runtime_providers if item.get("id") == provider_id), {})
        if model_id in _provider_models(static_providers.get(provider_id)) or model_id in _provider_models(runtime):
            matches.append(provider_id)
    provider_id = requested_id
    if not provider_id:
        if len(matches) == 1:
            provider_id = matches[0]
        elif len(matches) > 1:
            raise ValueError(f"白盒裁判模型 {model_id} 同时存在于多个 HarmonyBot Provider（{', '.join(matches)}），"
                             "请配置 whiteboxEvaluation.judge.providerId")
        else:
            raise ValueError(f"HarmonyBot 运行时未配置白盒裁判模型: {model_id}")

    static = static_providers.get(provider_id)
    runtime = next((item for item in runtime_providers if item.get("id") == provider_id), None)
    if static is None and runtime is None:
        available = f"；可用 Provider: {', '.join(provider_ids)}" if provider_ids else ""
        raise ValueError(f"HarmonyBot 运行时未配置白盒裁判 Provider: {provider_id}{available}")
    static_models = _provider_models(static)
    runtime_models = _provider_models(runtime)
    if model_id not in static_models and model_id not in runtime_models:
        available_models = list(dict.fromkeys([*static_models, *runtime_models]))
        available = f"；可用模型: {', '.join(available_models)}" if available_models else ""
        raise ValueError(f"HarmonyBot Provider {provider_id} 未配置白盒裁判模型: {model_id}{available}")

    options = {**_obj(_obj(runtime).get("options")), **_obj(_obj(static).get("options"))}
    key = _obj(runtime).get("key")
    if isinstance(key, str) and key:
        options["apiKey"] = key
    model = runtime_models.get(model_id)
    if model is None:
        model = static_models.get(model_id)
    return {"providerId": provider_id, "modelId": model_id,
            "providerConfig": {**_obj(static), "options": options,
                               "models": {model_id: model if model is not None else {}}}}

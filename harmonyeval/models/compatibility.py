"""EvalScope OpenAI-compatible model adapter shared by evaluation tasks."""

import os
import hashlib
import re

_inline_keys = {}


def normalize_api_key(value):
    """Keep literal credentials in memory; task/config caches receive a reference."""
    value = value.strip()
    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
        return value
    if any(character.isspace() for character in value):
        raise ValueError("model.api_key 密钥不能包含空白字符")
    reference = "__HARMONY_EVAL_INLINE_KEY_" + hashlib.sha256(value.encode()).hexdigest()
    _inline_keys[reference] = value
    return reference


def resolve_api_key(model):
    reference = model["api_key"]
    return _inline_keys.get(reference) or os.environ.get(reference)


def model_client(model, timeout):
    try:
        from evalscope.api.model import GenerateConfig
        from evalscope.models.openai_compatible import OpenAICompatibleAPI
    except ImportError as error:
        raise RuntimeError("缺少 EvalScope 模型适配依赖；请执行 pip install -e '.[eval]'") from error
    key_name = model["api_key"]
    key = resolve_api_key(model)
    if not key:
        raise ValueError(f"模型密钥环境变量未设置: {key_name}")
    config = GenerateConfig(timeout=timeout, max_tokens=model.get("max_tokens", 4096),
                            temperature=model.get("temperature", 0), retries=model.get("retries", 1),
                            retry_interval=1, seed=model.get("seed"))
    api = OpenAICompatibleAPI(model_name=model["name"], base_url=model["base_url"],
                              api_key=key, config=config, max_retries=0)
    from urllib.parse import urlsplit
    if urlsplit(model["base_url"]).hostname in ("127.0.0.1", "localhost", "::1"):
        # The local model proxy/mock must not be sent through ambient corporate proxies.
        import httpx
        from openai import OpenAI
        api.client.close()
        api.client = OpenAI(api_key=key, base_url=model["base_url"], max_retries=0,
                            http_client=httpx.Client(trust_env=False))
        api._async_client_kwargs["http_client"] = httpx.AsyncClient(trust_env=False)
        api._harmony_eval_http_async_client = api._async_client_kwargs["http_client"]
    return api, config


def evalscope_model(settings, timeout=120):
    from evalscope.api.model import Model
    api, config = model_client(settings, timeout)
    return Model(api=api, config=config)


async def close_model(model):
    await model.api.aclose()
    asynchronous = getattr(model.api, "_harmony_eval_http_async_client", None)
    if asynchronous is not None and not asynchronous.is_closed:
        await asynchronous.aclose()
    client = getattr(model.api, "client", None)
    if client and hasattr(client, "close"):
        client.close()


def probe_model(model, timeout):
    """Exercise EvalScope's actual ModelAPI before starting the costly device run."""
    from evalscope.api.messages import ChatMessageUser

    client, config = model_client(model, timeout)
    output = client.generate(input=[ChatMessageUser(content="Reply with OK.")], tools=[],
                             tool_choice=None, config=config)
    if not output.choices or not output.choices[0].message.text.strip():
        raise RuntimeError("EvalScope 模型兼容调用未返回文本")
    return {"framework": "evalscope", "api": "OpenAICompatibleAPI",
            "model": model["name"], "status": "passed"}

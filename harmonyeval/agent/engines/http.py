"""Execute a question through the HTTP agent model bridge."""

import asyncio
import json
import time
from harmonyeval.api.registry import executors
from harmonyeval.api.contracts import ExecutionResult


@executors.register("http")
class HttpExecutor:
    version = "1"
    schema = {"type": "object", "required": ["http_url"],
              "properties": {"http_url": {"type": "string", "pattern": "^https?://"}}}

    async def execute(self, public_case, target, context):
        from evalscope.api.messages import ChatMessageUser
        start = time.monotonic()
        # The remote system is itself a ModelAPI, not an assumed internal LLM.
        output = await asyncio.to_thread(context["model"].generate,
                                         [ChatMessageUser(content=json.dumps(public_case))])
        if output.error:
            raise RuntimeError(output.error)
        return ExecutionResult("completed", answer=output.completion,
                               elapsed_seconds=time.monotonic() - start,
                               usage={"tokens": None, "internal_model": "unknown"},
                               capabilities=target["manifest"],
                               artifacts={"remote_session_id": (output.metadata or {}).get("session_id")})

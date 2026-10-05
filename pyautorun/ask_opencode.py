"""Send direct messages to an existing OpenCode server from Python."""

import argparse
import asyncio
import json
import os
import sys

from .opencode import OpenCodeClient


def _parts(raw, include_thinking):
    value = json.loads(raw) if isinstance(raw, str) else raw
    parts = (value or {}).get("parts") or []
    return "\n".join(part.get("text") or "" for part in parts
                     if part.get("type") == "text" or include_thinking and part.get("type") == "reasoning").strip()


async def _run(args):
    client = OpenCodeClient(f"http://{args.host}:{args.port}")
    config = await client.get_config(args.timeout, args.cwd)
    model = None
    if args.model:
        if "/" in args.model:
            provider_id, model_id = args.model.split("/", 1)
        else:
            matches = [(key, args.model) for key, provider in (config.get("provider") or {}).items()
                       if args.model in ((provider or {}).get("models") or {})]
            if len(matches) != 1:
                raise ValueError(f"无法唯一识别模型: {args.model}")
            provider_id, model_id = matches[0]
        model = {"providerID": provider_id, "modelID": model_id}
    session = await client.create_session(args.cwd, args.timeout)
    session_id = session.get("id")
    if not session_id:
        raise RuntimeError("OpenCode 未返回 session id")
    async def ask(question):
        payload = {"parts": [{"type": "text", "text": question}]}
        if args.agent:
            payload["agent"] = args.agent
        if model:
            payload["model"] = model
        raw = await client.send_message_text(session_id, payload, args.cwd, args.timeout)
        print(raw if args.raw else _parts(raw, args.think))
    question = args.question or (sys.stdin.readline().rstrip("\n") if not sys.stdin.isatty() else "")
    if question:
        await ask(question)
    if sys.stdin.isatty():
        while True:
            try:
                question = input("> ").strip()
            except EOFError:
                break
            if question in (":q", ":quit"):
                break
            if question:
                await ask(question)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Ask an existing OpenCode server")
    parser.add_argument("question", nargs="?", default="")
    parser.add_argument("--host", "-H", default=os.environ.get("HOST") or "127.0.0.1")
    parser.add_argument("--port", "-p", type=int, default=int(os.environ.get("PORT") or 61417))
    parser.add_argument("--timeout", "-t", type=int, default=int(os.environ.get("TIMEOUT") or 120))
    parser.add_argument("--cwd", "-C", default=os.environ.get("CWD") or os.getcwd())
    parser.add_argument("--agent", "-a", default=os.environ.get("AGENT") or "")
    parser.add_argument("--model", "-m", default=os.environ.get("MODEL") or "")
    parser.add_argument("--think", action="store_true")
    parser.add_argument("--raw", action="store_true")
    args = parser.parse_args(argv)
    try:
        asyncio.run(_run(args))
        return 0
    except KeyboardInterrupt:
        return 130
    except Exception as error:
        print(f"OpenCode 请求失败: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

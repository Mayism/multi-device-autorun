"""Run the configured OpenCode server as a standalone Python command."""

import argparse
import asyncio
from pathlib import Path
import sys

from pyautorun.orchestration.config import load_autorun_config
from pyautorun.runtime.opencode_server import start_server


async def _run(args):
    config = load_autorun_config(args.config)
    if args.source:
        source = Path(args.source).resolve()
        root = source.parent.parent if source.name == "opencode" and source.parent.name == "resources" else source
        config["server"]["opencodeSource"] = {"mode": "softwareEngineering", "root": str(root)}
    if args.runtime_root:
        config["server"]["runtimeRoot"] = str(Path(args.runtime_root).resolve())
    if args.deveco_home:
        config["server"]["devecoHome"] = str(Path(args.deveco_home).resolve())
    if args.port:
        config["server"]["url"] = f"http://127.0.0.1:{args.port}"
    workspace = Path(args.workspace or Path.cwd()).resolve()
    server = await start_server(config, workspace, reuse_existing=False, log=print)
    try:
        print(f"OpenCode Server: {server.server_url}", flush=True)
        while server.process and server.process.poll() is None:
            await asyncio.sleep(0.5)
        return 1 if server.process and server.process.returncode else 0
    finally:
        await server.stop()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Start OpenCode from the Autorun configuration")
    parser.add_argument("--config", required=True, help="Path to an explicit legacy JSON config")
    parser.add_argument("--source")
    parser.add_argument("--runtime-root")
    parser.add_argument("--workspace")
    parser.add_argument("--port", type=int)
    parser.add_argument("--deveco-home")
    args = parser.parse_args(argv)
    try:
        return asyncio.run(_run(args))
    except KeyboardInterrupt:
        return 130
    except Exception as error:
        print(f"OpenCode Server 启动失败: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

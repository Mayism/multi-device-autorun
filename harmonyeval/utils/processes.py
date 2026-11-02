"""Stop process trees and propagate evaluation cancellation."""

import asyncio
import os
import signal


async def stop_process(proc):
    if proc.returncode is not None:
        return
    try:
        if os.name == "nt":
            killer = await asyncio.create_subprocess_exec("taskkill", "/PID", str(proc.pid), "/T", "/F",
                                                          stdout=asyncio.subprocess.DEVNULL,
                                                          stderr=asyncio.subprocess.DEVNULL)
            await killer.wait()
        else:
            os.killpg(proc.pid, signal.SIGTERM)
        await asyncio.wait_for(proc.wait(), 5)
    except (ProcessLookupError, asyncio.TimeoutError):
        if proc.returncode is None:
            if os.name != "nt":
                os.killpg(proc.pid, signal.SIGKILL)
            else:
                proc.kill()
            await proc.wait()


async def watch_cancellation(proc, event):
    while proc.returncode is None:
        if event is not None and event.is_set():
            await stop_process(proc)
            return
        await asyncio.sleep(0.1)

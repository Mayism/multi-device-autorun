"""Run the selected target through one engine in a private per-case environment."""
import asyncio
from pathlib import Path
import tempfile
from harmonyeval.api import targets, executors
from harmonyeval.agent.model import task_model
from harmonyeval.models.compatibility import close_model


async def execute_agent(task, case, workspace, folder, cancel_event=None):
    target_adapter = targets.get(task['target']['type'])()
    with tempfile.TemporaryDirectory(prefix='harmony-eval-runtime-') as runtime:
        target = await asyncio.to_thread(target_adapter.prepare, task, runtime)
        local_model = task_model(task)
        try:
            return await executors.get(task['active']['execution']['engine'])().execute(
                case.public(), target, {'task': task, 'workspace': str(workspace),
                                        'output': str(folder), 'model': local_model,
                                        'cancel_event': cancel_event})
        finally:
            await close_model(local_model)

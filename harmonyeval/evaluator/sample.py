"""Execute a single prepared case and preserve engineering evidence."""
import asyncio
from pathlib import Path
from harmonyeval.api import datasets, ExecutionResult, PROJECT_DIRECTORY
from harmonyeval.agent.service import execute_agent
from harmonyeval.agent.environments.workspace import init_project, save_patch
from harmonyeval.verification.pipeline import capture_verification_inputs


def execute_sample(task, case, folder, cancel_event=None, adapter=None):
    adapter = adapter or datasets.get(task['dataset']['type'])()
    folder.mkdir(parents=True, exist_ok=True)
    workspace = folder / PROJECT_DIRECTORY
    try:
        if cancel_event is not None and cancel_event.is_set():
            raise InterruptedError('评测已中断')
        adapter.prepare(case, workspace)
        asyncio.run(capture_verification_inputs(task, case, folder))
        if case.project:
            baseline = init_project(workspace)
        execution = asyncio.run(execute_agent(task, case, workspace, folder, cancel_event))
        execution.workspace = str(workspace)
        execution.project = str(adapter.project_path(case, workspace)) if case.project else ''
        if case.project:
            save_patch(workspace, folder, baseline)
            if not Path(execution.project).is_dir():
                execution.status, execution.failure_category = 'failed', 'agent'
                execution.error = 'Agent未生成约定的目标工程: ' + execution.project
    except Exception as error:
        execution = ExecutionResult('interrupted' if isinstance(error, InterruptedError) else 'error', workspace=str(workspace),
                                     failure_category='user' if isinstance(error, InterruptedError) else 'infrastructure',
                                     error=f'{type(error).__name__}: {error}')
    archive = getattr(adapter, 'archive_evidence', None)
    if archive is not None:
        try:
            execution.artifacts.update(archive(case, folder))
        except Exception as error:
            message = f'评估输入归档失败: {type(error).__name__}: {error}'
            execution.error = f'{execution.error}; {message}' if execution.error else message
            if execution.status == 'completed':
                execution.status, execution.failure_category = 'error', 'infrastructure'
    execution.artifacts['case_output'] = str(folder)
    return execution

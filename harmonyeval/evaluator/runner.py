"""Drive one EvalScope evaluation and handle lifecycle cancellation."""

import asyncio
import threading
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from uuid import uuid4
from harmonyeval.utils.security import redact
from harmonyeval.report.task import write_task_report
from harmonyeval.evaluator.preflight import check_task
from harmonyeval.evaluator.identity import execution_identity, scoring_identity, verification_identity


def _run_single_sync(task, on_log=print, cancel_event=None, output_root=None):
    checked = check_task(task, inspect=False)
    if not checked['ready']:
        raise ValueError('运行前缺少: ' + '、'.join(checked['missing']))
    from evalscope.api.registry import get_benchmark
    from evalscope.config import TaskConfig
    from evalscope.evaluator.evaluator import DefaultEvaluator
    from evalscope.utils.io_utils import OutputsStructure
    from harmonyeval.evaluator.compat import require_evalscope
    from harmonyeval.agent.model import task_model
    require_evalscope()
    run_id = datetime.now().strftime('%Y%m%d%H%M%S') + '-' + uuid4().hex[:6]
    root = Path(output_root) if output_root is not None else Path(task['active']['report']['output_dir']) / run_id
    root.mkdir(parents=True)
    import yaml
    (root / 'task.resolved.yaml').write_text(yaml.safe_dump(
        redact({k: v for k, v in task.items() if k != 'active'}), allow_unicode=True, sort_keys=False))
    model = task_model(task)
    config = TaskConfig(model=model, model_id=task['id'], datasets=['harmony_eval'], eval_type='custom',
                        dataset_args={'harmony_eval': {'extra_params': {'task': task, 'run_root': str(root)}}},
                        repeats=1, eval_batch_size=task['active']['execution']['concurrency'],
                        work_dir=str(root / 'evalscope'), no_timestamp=True, collect_perf=False,
                        ignore_errors=False, enable_progress_tracker=False)
    benchmark = get_benchmark('harmony_eval', config)
    benchmark.cancel_event = cancel_event
    evaluator = DefaultEvaluator(benchmark=benchmark, model=model,
                                 outputs=OutputsStructure(str(root / 'evalscope')), task_config=config)
    identities = {'execution_fingerprint': execution_identity(task, benchmark.cases),
                  'verification_fingerprint': verification_identity(task, benchmark.cases),
                  'scoring_fingerprint': scoring_identity(task)}
    if task.get('experiment'):
        shared = deepcopy(task)
        shared.pop('experiment')
        if 'capability' in task['experiment']['overrides']:
            shared['active']['execution']['agent_name'] = task['experiment']['agents']['with']
        identities['experiment_context_fingerprint'] = execution_identity(shared, benchmark.cases)
    on_log(f"[harmonyeval] {task['id']}：{checked['cases']}个用例 × {checked['rounds']}轮，{task['variant']}")
    error = None
    try:
        evaluator.eval()
    except BaseException as exc:
        error = exc
    finally:
        from harmonyeval.models.compatibility import close_model
        asyncio.run(close_model(model))
        payload = {'schema_version': 2, 'run_id': run_id, 'task_id': task['id'], 'scenario': task['scenario'],
                   'task_source': task['source'], 'variant': task['variant'], 'target': task['target'],
                   'execution_config': redact(task['active']['execution']), 'dataset': task['dataset'],
                   **({'experiment': task['experiment']} if task.get('experiment') else {}),
                   **identities,
                   'planned_samples': checked['cases'] * checked['rounds'],
                   'records': sorted(benchmark.records, key=lambda r: (r['round'], r['case_id'])),
                   'evalscope_version': checked['evalscopeVersion'], 'error': str(error) if error else None}
        path = write_task_report(payload, root)
    if error:
        raise error
    records = payload['records']
    return {'exitCode': report_exit_code(payload), 'reportPath': path, 'runRoot': str(root), 'records': len(records)}


def report_exit_code(report):
    records = report['records']
    failed = (bool(report.get('error')) or len(records) != report['planned_samples']
              or any(r['execution']['status'] != 'completed' for r in records)
              or any(s['status'] != 'scored' for r in records for s in r['scores'].values()))
    return 1 if failed else 0


async def run_task(task, on_log=print):
    from harmonyeval.experiments.runner import _run_sync
    cancelled = threading.Event()
    worker = asyncio.create_task(asyncio.to_thread(_run_sync, task, on_log, cancelled))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        cancelled.set()
        await asyncio.shield(worker)
        raise

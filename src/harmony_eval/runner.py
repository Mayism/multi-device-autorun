"""Plan, execute, re-verify and re-score task YAML through EvalScope."""
import asyncio
from copy import deepcopy
from datetime import datetime
from importlib import metadata
import json
import os
from pathlib import Path
import sys
import tempfile
import shutil
import threading
from uuid import uuid4

from pyautorun.harmony_eval.core import datasets, targets, executors, verifiers, scorers, ExecutionResult, fingerprint, redact, file_fingerprint
from pyautorun.harmony_eval.report import write_task_report
from pyautorun.harmony_eval.score_rules import calculate_scores
from pyautorun.harmony_eval.target_adapters import inspect_runtime
from pyautorun.harmony_eval.verification import pipeline


def execution_identity(task, cases):
    adapter = datasets.get(task['dataset']['type'])()
    source = targets.get(task['target']['type'])().source(task)
    paths = []
    if source.get('binary'):
        paths.append(Path(source['binary']))
    root = source.get('config_root')
    if root:
        for name in ('opencode.json', 'opencode.jsonc'):
            paths.append(Path(root) / name)
    if task['target'].get('dir') and task['target']['type'] in ('skills', 'plugin_agent'):
        paths.extend(Path(task['target']['dir']).rglob('*'))
    if task['active']['execution']['opencode'].get('config_path'):
        paths.append(Path(task['active']['execution']['opencode']['config_path']))
    contents = [(str(p), file_fingerprint(p)) for p in paths if p.is_file() and '.git' not in p.parts]
    versions = [(registry.group, name, getattr(registry.get(name), 'version', '1')) for registry, name in (
        (datasets, task['dataset']['type']), (targets, task['target']['type']),
        (executors, task['active']['execution']['engine']))]
    return fingerprint({'adapter_versions': versions, 'dataset': task['dataset'], 'inputs': [(c.case_id, adapter.fingerprint(c)) for c in cases],
                        'target': task['target'], 'execution': task['active']['execution'], 'rounds': task['active']['rounds'],
                        'capability_source_files': contents})


def walk_flows(flows):
    for flow in flows:
        yield flow
        yield from walk_flows(flow.get('steps', []))


def verification_identity(task, cases):
    adapter = datasets.get(task['dataset']['type'])()
    rubrics = []
    versions = []
    for flow in walk_flows(task['active']['verification']):
        versions.append((flow['type'], getattr(verifiers.get(flow['type']), 'version', '1')))
        for name in ('rubric_path', 'prompt_path', 'workflow_path', 'skill_path'):
            if flow.get(name):
                source = Path(flow[name])
                files = sorted(source.rglob('*')) if source.is_dir() else [source]
                rubrics.extend((str(path), file_fingerprint(path)) for path in files if path.is_file())
    return fingerprint({'versions': versions, 'flows': task['active']['verification'], 'rubrics': rubrics,
                        'evidence': [adapter.evidence_fingerprint(c) for c in cases]})


def scoring_identity(task):
    rules = task['active']['scoring']
    return fingerprint({'rules': rules, 'versions': [(rule['type'], getattr(scorers.get(rule['type']), 'version', '1')) for rule in rules]})


def check_task(task, inspect=True):
    cases = datasets.get(task['dataset']['type'])().load(task['dataset'])
    missing, manifest, warnings = [], {}, []
    if sys.version_info < (3, 10):
        missing.append('Python 3.10+（建议3.12）')
    try:
        installed = metadata.version('evalscope')
        if not installed.startswith('1.14.'):
            missing.append('EvalScope 1.14.x')
    except metadata.PackageNotFoundError:
        installed = None
        missing.append("EvalScope 1.14.x：pip install -e '.[eval]'")
    configs = [f.get('model') for f in walk_flows(task['active']['verification'])]
    from importlib.util import find_spec
    for flow in walk_flows(task['active']['verification']):
        dependencies = getattr(verifiers.get(flow['type']), 'python_dependencies', ())
        absent = [name for name in dependencies if find_spec(name) is None]
        if absent:
            missing.append(f"{flow['type']} Python依赖 {', '.join(absent)}；请安装对应评估器依赖（内置评估器：pip install -e '.[eval]'）")
    execution = task['active']['execution']
    if execution.get('model'):
        configs.append(execution['model'])
    from pyautorun.harmony_eval.model import resolve_api_key
    for model in configs:
        if model and not resolve_api_key(model):
            missing.append('模型密钥环境变量 ' + model['api_key'])
    for case in cases:
        if case.project and (Path(case.project) / 'pubspec.yaml').is_file() and not execution.get('enviroment', {}).get('flutter_home') and not shutil.which('flutter'):
            warnings.append(f'{case.case_id}: 未配置flutter_home，PATH中也没有flutter')
        for flow in task['active']['verification']:
            if flow['type'] == 'LibraryAPICompatibility' and not case.expected.get('api_mapping'):
                warnings.append(f'{case.case_id}/{flow["id"]}: 未提供API映射，结果将不可用')
            if flow['type'] == 'LibraryTests':
                from pyautorun.harmony_eval.verification import workflow_settings
                settings = workflow_settings(case, flow)
                if not settings.get('build_command') or not settings.get('test_command'):
                    warnings.append(f'{case.case_id}/{flow["id"]}: 未提供构建及功能验收命令，结果将不可用')
    target = targets.get(task['target']['type'])()
    source = target.source(task)
    if execution['engine'] == 'opencode' and inspect:
        with tempfile.TemporaryDirectory(prefix='harmony-eval-plan-') as runtime:
            prepared = target.prepare(task, runtime)
            workspace = Path(runtime) / 'workspace'
            workspace.mkdir()
            manifest = inspect_runtime(prepared, execution['agent_name'], str(workspace))
    else:
        manifest = source
    return {'taskId': task['id'], 'scenario': task['scenario'], 'dataset': task['dataset'],
            'cases': len(cases), 'caseIds': [case.case_id for case in cases], 'rounds': task['active']['rounds'],
            'targets': 1, 'variant': task['variant'], 'capabilities': redact(manifest),
            'verification': [{'id': f['id'], 'type': f['type']} for f in task['active']['verification']],
            'static_eval': 'reserved' if 'static_eval' in task['active'] else 'absent',
            'evalscopeVersion': installed, 'missing': sorted(set(missing)), 'warnings': sorted(set(warnings)), 'ready': not missing}


def _run_sync(task, on_log=print, cancel_event=None):
    checked = check_task(task, inspect=False)
    if not checked['ready']:
        raise ValueError('运行前缺少: ' + '、'.join(checked['missing']))
    from evalscope.api.registry import get_benchmark
    from evalscope.config import TaskConfig
    from evalscope.evaluator.evaluator import DefaultEvaluator
    from evalscope.utils.io_utils import OutputsStructure
    from pyautorun.harmony_eval.evalscope_adapter import require_evalscope, task_model
    require_evalscope()
    run_id = datetime.now().strftime('%Y%m%d%H%M%S') + '-' + uuid4().hex[:6]
    root = Path(task['active']['report']['output_dir']) / run_id
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
    on_log(f"[harmony-eval] {task['id']}：{checked['cases']}个用例 × {checked['rounds']}轮，{task['variant']}")
    error = None
    try:
        evaluator.eval()
    except BaseException as exc:
        error = exc
    finally:
        from pyautorun.harmony_eval.model import close_model
        asyncio.run(close_model(model))
        payload = {'schema_version': 2, 'run_id': run_id, 'task_id': task['id'], 'scenario': task['scenario'],
                   'task_source': task['source'], 'variant': task['variant'], 'target': task['target'],
                   'execution_config': redact(task['active']['execution']), 'dataset': task['dataset'],
                   **identities,
                   'planned_samples': checked['cases'] * checked['rounds'],
                   'records': sorted(benchmark.records, key=lambda r: (r['round'], r['case_id'])),
                   'evalscope_version': checked['evalscopeVersion'], 'error': str(error) if error else None}
        path = write_task_report(payload, root)
    if error:
        raise error
    records = payload['records']
    unavailable = any(s['status'] != 'scored' for r in records for s in r['scores'].values())
    failed = any(r['execution']['status'] != 'completed' for r in records)
    return {'exitCode': 1 if failed or unavailable else 0, 'reportPath': path, 'runRoot': str(root), 'records': len(records)}


async def run_task(task, on_log=print):
    cancelled = threading.Event()
    worker = asyncio.create_task(asyncio.to_thread(_run_sync, task, on_log, cancelled))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        cancelled.set()
        await asyncio.shield(worker)
        raise


def load_report(path):
    root = Path(path).expanduser().resolve()
    source = root / 'task-report.json' if root.is_dir() else root
    data = json.loads(source.read_text())
    if data.get('schema_version') != 2:
        raise ValueError('复评需要v2 task-report.json')
    return source.parent, data


def replay(task, previous, verify=False):
    root, data = load_report(previous)
    cases = datasets.get(task['dataset']['type'])().load(task['dataset'])
    if execution_identity(task, cases) != data['execution_fingerprint']:
        raise ValueError('执行输入、模型、目标或能力配置已变化，不能复用旧结果')
    if not verify and verification_identity(task, cases) != data['verification_fingerprint']:
        raise ValueError('评估流程已变化；请先verify，再rescore')
    by_id = {case.case_id: case for case in cases}
    for record in data['records']:
        if verify:
            execution = ExecutionResult(**record['execution'])
            if execution.project and not Path(execution.project).is_dir():
                raise ValueError('工程产物已不存在，无法复评')
            record['verification'] = asyncio.run(pipeline(task, by_id[record['case_id']], execution,
                                                          execution.artifacts['case_output']))
        record['scores'] = calculate_scores(record['verification'], task['active']['scoring'])
    data['verification_fingerprint'] = verification_identity(task, cases)
    data['scoring_fingerprint'] = scoring_identity(task)
    return write_task_report(data, root)

"""Inspect dependencies, datasets and resolved target capabilities."""

import sys
import tempfile
import shutil
from importlib import metadata
from pathlib import Path
from harmonyeval.api.registry import datasets, targets, verifiers
from harmonyeval.utils.security import redact
from harmonyeval.experiments.config import expand_experiments
from harmonyeval.agent.targets.inspection import inspect_runtime
from harmonyeval.evaluator.identity import walk_flows


def check_task(task, inspect=True):
    if 'experiments' not in task:
        return _check_single_task(task, inspect)
    plans = []
    for child in expand_experiments(task):
        try:
            plan = _check_single_task(child, inspect)
        except Exception as error:
            plan = {'ready': False, 'missing': [], 'error': str(error)}
        plans.append({'experiment': child['experiment'], **plan})
    return {'taskId': task['id'], 'scenario': task['scenario'], 'experimentCount': len(plans),
            'baseline': task['experiments'][0]['id'], 'experiments': plans,
            'ready': all(plan['ready'] for plan in plans)}


def _check_single_task(task, inspect=True):
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
    from harmonyeval.models.compatibility import resolve_api_key
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
                from harmonyeval.verification.context import workflow_settings
                settings = workflow_settings(case, flow)
                if not settings.get('build_command') or not settings.get('test_command'):
                    warnings.append(f'{case.case_id}/{flow["id"]}: 未提供构建及功能验收命令，结果将不可用')
    target = targets.get(task['target']['type'])()
    source = target.source(task)
    if execution['engine'] == 'opencode' and (inspect or task.get('experiment')):
        with tempfile.TemporaryDirectory(prefix='harmony-eval-plan-') as runtime:
            prepared = target.prepare(task, runtime)
            workspace = Path(runtime) / 'workspace'
            workspace.mkdir()
            manifest = inspect_runtime(prepared, execution['agent_name'], str(workspace)) if inspect else prepared['manifest']
    else:
        manifest = source
    return {'taskId': task['id'], 'scenario': task['scenario'], 'dataset': task['dataset'],
            'cases': len(cases), 'caseIds': [case.case_id for case in cases], 'rounds': task['active']['rounds'],
            'targets': 1, 'variant': task['variant'], 'capabilities': redact(manifest),
            'verification': [{'id': f['id'], 'type': f['type']} for f in task['active']['verification']],
            'static_eval': 'reserved' if 'static_eval' in task['active'] else 'absent',
            'evalscopeVersion': installed, 'missing': sorted(set(missing)), 'warnings': sorted(set(warnings)), 'ready': not missing}

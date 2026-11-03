"""Run experiment groups and refresh paired comparisons."""

import json
from datetime import datetime
from pathlib import Path
from uuid import uuid4
from harmonyeval.utils.security import redact
from harmonyeval.report.experiments import write_experiments_report
from harmonyeval.report.comparison import compare_reports
from harmonyeval.experiments.config import expand_experiments, has_experiments
from harmonyeval.evaluator.runner import _run_single_sync, report_exit_code
from harmonyeval.evaluator.preflight import check_task
from harmonyeval.report.io import load_report


def update_experiment_comparisons(summary, reports, root):
    summary['comparisons'] = []
    baseline = summary['baseline']
    for name in [item['id'] for item in summary['experiments'] if item['id'] != baseline]:
        entry = {'left': baseline, 'right': name}
        relative = Path('comparisons') / name
        try:
            if baseline not in reports or name not in reports:
                raise ValueError('缺少实验组报告，无法配对比较')
            compare_reports(reports[baseline], reports[name], root / relative)
            entry.update({'status': 'completed', 'report': str(relative / 'index.html')})
        except Exception as error:
            # A failed re-comparison must not leave an earlier valid-looking result.
            for filename in ('index.html', 'comparison.json'):
                (root / relative / filename).unlink(missing_ok=True)
            entry.update({'status': 'unavailable', 'error': str(error)})
        summary['comparisons'].append(entry)
    failed = (summary['status'] == 'interrupted' or any(item['exitCode'] for item in summary['experiments'])
              or any(item['status'] != 'completed' for item in summary['comparisons']))
    summary['exitCode'] = 1 if failed else 0


def _run_sync(task, on_log=print, cancel_event=None):
    if not has_experiments(task):
        return _run_single_sync(task, on_log, cancel_event)
    checked = check_task(task, inspect=False)
    if not checked['ready']:
        problems = [f"{p['experiment']['id']}: {p.get('error') or '、'.join(p['missing'])}"
                    for p in checked['experiments'] if not p['ready']]
        raise ValueError('实验运行前检查失败: ' + '；'.join(problems))
    run_id = datetime.now().strftime('%Y%m%d%H%M%S') + '-' + uuid4().hex[:6]
    root = Path(task['active']['report']['output_dir']) / run_id
    root.mkdir(parents=True)
    import yaml
    (root / 'task.resolved.yaml').write_text(yaml.safe_dump(
        redact({k: v for k, v in task.items() if k != 'active'}), allow_unicode=True, sort_keys=False))
    children = expand_experiments(task)
    summary = {'schema_version': 2, 'report_type': 'experiments', 'run_id': run_id,
               'task_id': task['id'], 'baseline': children[0]['experiment']['id'],
               'experiments': [], 'comparisons': [], 'status': 'running'}
    reports = {}
    write_experiments_report(summary, root)
    for child in children:
        if cancel_event is not None and cancel_event.is_set():
            summary['status'] = 'interrupted'
            break
        name = child['experiment']['id']
        child_root = root / 'experiments' / name
        entry = {'id': name, 'overrides': child['experiment']['overrides'],
                 'report': str(Path('experiments') / name / 'index.html')}
        on_log(f'[harmonyeval] 实验 {name}')
        try:
            outcome = _run_single_sync(child, on_log, cancel_event, child_root)
            entry.update({'exitCode': outcome['exitCode'], 'status': 'completed' if not outcome['exitCode'] else 'incomplete'})
        except Exception as error:
            entry.update({'exitCode': 1, 'status': 'error', 'error': str(error)})
        if (child_root / 'task-report.json').is_file():
            _, report = load_report(child_root)
            reports[name] = report
            entry['aggregate'] = report['aggregate']
            entry['execution_summary'] = report['execution_summary']
        summary['experiments'].append(entry)
        write_experiments_report(summary, root)
    if summary['status'] != 'interrupted':
        summary['status'] = 'completed'
    update_experiment_comparisons(summary, reports, root)
    path = write_experiments_report(summary, root)
    return {'exitCode': summary['exitCode'], 'reportPath': path, 'runRoot': str(root),
            'experiments': len(summary['experiments']), 'records': sum(len(r['records']) for r in reports.values())}


def refresh_experiments_report(root):
    source = root / 'experiments-report.json'
    if not source.is_file():
        return
    summary = json.loads(source.read_text())
    reports = {}
    for item in summary['experiments']:
        child = root / 'experiments' / item['id']
        if not (child / 'task-report.json').is_file():
            continue
        _, report = load_report(child)
        reports[item['id']] = report
        item['aggregate'] = report['aggregate']
        item['execution_summary'] = report['execution_summary']
        item['exitCode'] = report_exit_code(report)
        item['status'] = 'completed' if not item['exitCode'] else 'incomplete'
    update_experiment_comparisons(summary, reports, root)
    write_experiments_report(summary, root)

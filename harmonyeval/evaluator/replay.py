"""Re-verify saved executions and recalculate scores from existing evidence."""

import asyncio
from pathlib import Path
from harmonyeval.api.registry import datasets
from harmonyeval.api.contracts import ExecutionResult
from harmonyeval.report.task import write_task_report
from harmonyeval.experiments.config import expand_experiments
from harmonyeval.metrics.scoring import calculate_scores
from harmonyeval.verification.pipeline import pipeline
from harmonyeval.evaluator.identity import execution_identity, scoring_identity, verification_identity
from harmonyeval.report.io import load_report
from harmonyeval.experiments.runner import refresh_experiments_report


def replay(task, previous, verify=False):
    root, data = load_report(previous)
    if 'experiments' in task:
        match = [child for child in expand_experiments(task) if child['experiment'] == data.get('experiment')]
        if not match:
            raise ValueError('报告的实验 ID 或 MCP 开关与当前 experiments 不一致')
        task = match[0]
    cases = datasets.get(task['dataset']['type'])().load(task['dataset'])
    if execution_identity(task, cases) != data['execution_fingerprint']:
        raise ValueError('执行输入、模型、目标或能力配置已变化，不能复用旧结果')
    if not verify and verification_identity(task, cases) != data['verification_fingerprint']:
        raise ValueError('评估流程已变化；请先verify，再rescore')
    by_id = {case.case_id: case for case in cases}
    adapter = datasets.get(task['dataset']['type'])()
    for record in data['records']:
        if verify:
            execution = ExecutionResult(**record['execution'])
            if execution.project and not Path(execution.project).is_dir():
                raise ValueError('工程产物已不存在，无法复评')
            archive = getattr(adapter, 'archive_evidence', None)
            if archive is not None:
                execution.artifacts.update(archive(by_id[record['case_id']], execution.artifacts['case_output']))
                record['execution'] = execution.to_dict()
            record['verification'] = asyncio.run(pipeline(task, by_id[record['case_id']], execution,
                                                          execution.artifacts['case_output']))
        record['scores'] = calculate_scores(record['verification'], task['active']['scoring'])
    data['verification_fingerprint'] = verification_identity(task, cases)
    data['scoring_fingerprint'] = scoring_identity(task)
    path = write_task_report(data, root)
    if data.get('experiment') and root.parent.name == 'experiments':
        refresh_experiments_report(root.parent.parent)
    return path

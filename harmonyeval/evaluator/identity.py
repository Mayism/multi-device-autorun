"""Fingerprint execution inputs, grading evidence and scoring rules."""

from pathlib import Path
from harmonyeval.api.registry import datasets, targets, executors, verifiers, scorers
from harmonyeval.utils.hashes import fingerprint, file_fingerprint


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
                        'capability_source_files': contents,
                        **({'experiment': task['experiment']} if task.get('experiment') else {})})


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

"""Read a versioned single-group evaluation report."""

import json
from pathlib import Path


def load_report(path):
    root = Path(path).expanduser().resolve()
    source = root / 'task-report.json' if root.is_dir() else root
    if not source.is_file() and (root / 'experiments-report.json').is_file():
        raise ValueError('请指定 experiments/<实验ID>/ 下的单组报告目录进行 compare/verify/rescore')
    data = json.loads(source.read_text(encoding="utf-8"))
    if data.get('schema_version') != 2:
        raise ValueError('复评需要v2 task-report.json')
    return source.parent, data

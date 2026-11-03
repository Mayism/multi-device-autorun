"""Render the experiment overview and comparison links."""

import json
from datetime import datetime, timezone
from html import escape
from pathlib import Path
from harmonyeval.utils.io import write_json


def write_experiments_report(payload, output):
    root = Path(output)
    payload['generated_at'] = datetime.now(timezone.utc).isoformat()
    write_json(root / 'experiments-report.json', payload)
    def link(path, title):
        if not path or not (root / path).is_file():
            return escape(title)
        return '<a href="' + escape(path, quote=True) + '">' + escape(title) + '</a>'
    rows = []
    for group in payload['experiments']:
        values = [link(group.get('report'), group['id']), escape(group['status']),
                  '<pre>' + escape(json.dumps(group['overrides'], ensure_ascii=False, indent=2)) + '</pre>',
                  '<pre>' + escape(json.dumps(group.get('aggregate', {}), ensure_ascii=False, indent=2)) + '</pre>',
                  escape(group.get('error', ''))]
        rows.append('<tr>' + ''.join('<td>' + value + '</td>' for value in values) + '</tr>')
    comparisons = ['<li>' + link(c.get('report'), c['right'] + ' − ' + c['left']) + ' · ' +
                   escape(c['status']) + ' ' + escape(c.get('error', '')) + '</li>' for c in payload['comparisons']]
    html = ('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Harmony Eval experiments</title>'
            '<style>body{font:15px/1.5 system-ui;max-width:1200px;margin:32px auto;padding:0 24px}'
            'table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:12px;text-align:left;vertical-align:top}'
            'pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Harmony Eval · ' + escape(payload['task_id']) +
            '</h1><p>状态：' + escape(payload['status']) + '；基准组：' + escape(payload['baseline']) +
            '。对比差值为当前组减基准组；缺失证据不计零分。</p><table><tr><th>实验组</th><th>状态</th>'
            '<th>评测能力开关</th><th>评分</th><th>诊断</th></tr>' + ''.join(rows) +
            '</table><h2>配对比较</h2><ul>' + ''.join(comparisons) + '</ul></html>')
    path = root / 'index.html'
    path.write_text(html, encoding='utf-8')
    return str(path)

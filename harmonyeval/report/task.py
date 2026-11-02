"""Render one task report from its structured results."""

import json
from datetime import datetime, timezone
from html import escape
from pathlib import Path
from harmonyeval.utils.io import write_json
from harmonyeval.metrics.aggregation import aggregate


def write_task_report(payload, output):
    root = Path(output)
    root.mkdir(parents=True, exist_ok=True)
    payload['generated_at'] = datetime.now(timezone.utc).isoformat()
    records = payload.get('records', [])
    planned = payload.get('planned_samples', len(records))
    payload['aggregate'] = aggregate(records, planned)
    completed = sum(r['execution']['status'] == 'completed' for r in records)
    payload['execution_summary'] = {'planned': planned, 'recorded': len(records), 'completed': completed,
                                    'failed': len(records) - completed, 'missing': planned - len(records),
                                    'completion_rate': completed / planned if planned else 0}
    write_json(root / 'task-report.json', payload)
    columns = list(payload['aggregate'])
    rows = []
    for record in records:
        execution = record['execution']
        name = escape(record['case_id'])
        trace = Path(execution.get('artifacts', {}).get('case_output', root)) / 'generate/agent-output.html'
        if trace.is_file() and root.resolve() in trace.resolve().parents:
            name = '<a href="' + escape(str(trace.relative_to(root)), quote=True) + '">' + name + '</a>'
        cells = [escape(str(record['round'])), name, escape(execution['status'])]
        for name in columns:
            score = record['scores'].get(name, {})
            text = f"{score['score']:.2f}" if score.get('score') is not None else '证据不足'
            details = json.dumps(score, ensure_ascii=False, indent=2)
            cells.append('<details><summary>' + text + '</summary><pre>' + escape(details) + '</pre></details>')
        errors = [execution.get('error', '')]
        errors.extend(f"{key}: {value.get('error', '')}" for key, value in record['verification'].items() if value.get('error'))
        cells.append('<pre>' + escape('\n'.join(e for e in errors if e)) + '</pre><details><summary>答案与评估证据</summary><pre>' +
                     escape(json.dumps({'answer': execution.get('answer'), 'verification': record['verification']}, ensure_ascii=False, indent=2)) + '</pre></details>')
        rows.append('<tr>' + ''.join('<td>' + cell + '</td>' for cell in cells) + '</tr>')
    summaries = ['<li>' + escape(name) + ': ' +
                 (f"{item['mean']:.2f}" if item['mean'] is not None else '证据不足') +
                 f" · 已评分 {item['scored']}/{item['total']}</li>" for name, item in payload['aggregate'].items()]
    header = ''.join('<th>' + escape(name) + '</th>' for name in ['轮次', '用例', '执行状态', *columns, '诊断'])
    html = ('<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Harmony Eval</title>'
            '<style>body{font:15px/1.5 system-ui;margin:32px auto;padding:0 24px;max-width:1400px;color:#18212d;background:#f7f9fc}'
            'table{border-collapse:collapse;width:100%;background:white}th,td{padding:12px;text-align:left;border-bottom:1px solid #dde5ef;vertical-align:top}'
            'pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:650px}summary{cursor:pointer}.scroll{overflow:auto}</style>'
            '<h1>Harmony Eval · ' + escape(payload['task_id']) + '</h1><p>' + escape(payload['scenario']) + ' · ' +
            escape(payload['variant']) + f' · 完成 {completed}/{planned}</p><ul>' + ''.join(summaries) +
            '</ul><p>平均分只使用有证据的样本；同时展示覆盖率，缺失证据不转换为零分。</p>' +
            ('<pre>' + escape(payload['error']) + '</pre>' if payload.get('error') else '') +
            '<div class="scroll"><table><thead><tr>' + header + '</tr></thead><tbody>' + ''.join(rows) + '</tbody></table></div></html>')
    path = root / 'index.html'
    path.write_text(html, encoding='utf-8')
    return str(path)

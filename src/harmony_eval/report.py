"""One consolidated source of truth and a dimension-independent HTML report."""
from datetime import datetime, timezone
from html import escape
import json
from pathlib import Path

from pyautorun.harmony_eval.core import write_json


def aggregate(records, planned):
    names = sorted({key for record in records for key in record['scores']})
    return {name: {'mean': sum(values) / len(values) if values else None,
                   'scored': len(values), 'total': planned,
                   'coverage': len(values) / planned if planned else 0}
            for name in names
            for values in [[r['scores'][name]['score'] for r in records
                            if name in r['scores'] and r['scores'][name]['status'] == 'scored']]}


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


def compare_reports(first, second, output):
    def inputs(data):
        return {(r['case_id'], r['round']): r for r in data['records']}
    left, right = inputs(first), inputs(second)
    if first['scenario'] != second['scenario'] or first['target'] != second['target']:
        raise ValueError('两组场景或评测对象不同，不能计算同一能力的效果差值')
    for key in set(left) & set(right):
        if left[key]['input_fingerprint'] != right[key]['input_fingerprint']:
            raise ValueError(f'用例输入不一致: {key}')
        a = left[key]['execution'].get('capabilities', {})
        b = right[key]['execution'].get('capabilities', {})
        if a.get('host_config_fingerprint') != b.get('host_config_fingerprint') or a.get('version') != b.get('version'):
            raise ValueError('两组宿主配置或引擎版本不同，不能只归因于目标能力开关')
    if first['target']['type'] in ('harmonybot_agent', 'opencode_agent') and first['execution_config'].get('agent_name') != second['execution_config'].get('agent_name'):
        raise ValueError('直接Agent/MCP对照需要保持相同Agent')
    if first['verification_fingerprint'] != second['verification_fingerprint'] or first['scoring_fingerprint'] != second['scoring_fingerprint']:
        raise ValueError('两组评估流程或评分规则不同，不能计算效果差值')
    def execution_settings(data):
        config = dict(data['execution_config'])
        config.pop('agent_name', None)
        config.pop('without_enable', None)
        # MCP experiments commonly use separate JSON files. Actual resolved host
        # fingerprints above, rather than file names, determine comparability.
        if data['scenario'] == 'KnowledgeEval' and all(
                record['execution'].get('capabilities', {}).get('host_config_fingerprint')
                for record in data['records']) and data['records']:
            config['opencode'] = dict(config.get('opencode', {}))
            config['opencode'].pop('config_path', None)
        return config
    if execution_settings(first) != execution_settings(second):
        raise ValueError('两组模型、执行环境、工具预算或引擎配置来源不一致')
    pairs = []
    names = sorted(set(first['aggregate']) | set(second['aggregate']))
    for key in sorted(set(left) | set(right)):
        a, b = left.get(key), right.get(key)
        scores = {}
        for name in names:
            x, y = (a or {}).get('scores', {}).get(name, {}), (b or {}).get('scores', {}).get(name, {})
            valid = x.get('status') == y.get('status') == 'scored'
            scores[name] = {'left': x.get('score'), 'right': y.get('score'),
                            'delta': y['score'] - x['score'] if valid else None}
        pairs.append({'case_id': key[0], 'round': key[1], 'scores': scores,
                      'left_execution': a['execution']['status'] if a else 'missing',
                      'right_execution': b['execution']['status'] if b else 'missing'})
    aggregate_values = {}
    for name in names:
        values = [p['scores'][name]['delta'] for p in pairs if p['scores'][name]['delta'] is not None]
        aggregate_values[name] = {'mean_delta': sum(values) / len(values) if values else None,
                                  'paired_scored': len(values), 'total_union': len(pairs)}
    data = {'schema_version': 2, 'left': first['run_id'], 'right': second['run_id'],
            'left_summary': first['execution_summary'], 'right_summary': second['execution_summary'],
            'delta_direction': 'right-minus-left', 'aggregate': aggregate_values, 'pairs': pairs}
    root = Path(output)
    root.mkdir(parents=True, exist_ok=True)
    write_json(root / 'comparison.json', data)
    (root / 'index.html').write_text('<!doctype html><meta charset="utf-8"><title>Harmony Eval comparison</title>'
                                    '<h1>评测对比（右组减左组）</h1><pre>' + escape(json.dumps(data, ensure_ascii=False, indent=2)) + '</pre>')
    return str(root / 'index.html')

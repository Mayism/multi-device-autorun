"""Validate comparability and render paired score differences."""

import json
from html import escape
from pathlib import Path
from harmonyeval.utils.io import write_json


def compare_reports(first, second, output):
    def inputs(data):
        return {(r['case_id'], r['round']): r for r in data['records']}
    left, right = inputs(first), inputs(second)
    if first['scenario'] != second['scenario'] or first['target'] != second['target']:
        raise ValueError('两组场景或评测对象不同，不能计算同一能力的效果差值')
    experiments = bool(first.get('experiment') or second.get('experiment'))
    controlled = []
    capability_comparison = False
    if experiments:
        if not first.get('experiment') or not second.get('experiment'):
            raise ValueError('experiments 报告必须与另一实验组报告比较')
        a_control, b_control = first['experiment']['overrides'], second['experiment']['overrides']
        if set(a_control) != set(b_control):
            raise ValueError('两组对照控制的能力类型不同')
        capability_comparison = 'capability' in a_control
        if capability_comparison:
            if first['target']['type'] not in ('skills', 'plugin_agent'):
                raise ValueError('能力加载对照仅支持 Skill/Plugin')
            agents = first['experiment'].get('agents')
            if not agents or agents != second['experiment'].get('agents'):
                raise ValueError('两组对照 Agent 声明不一致')
            for report in (first, second):
                group = report['experiment']
                enabled = group['overrides']['capability'].get('enabled')
                if group['id'] not in ('with', 'without') or enabled is not (group['id'] == 'with'):
                    raise ValueError('能力对照组 ID 与启用状态不一致')
                if report['execution_config'].get('agent_name') != agents[group['id']]:
                    raise ValueError('实际 Agent 与能力对照声明不一致')
        else:
            controlled = sorted(a_control['mcp'])
            if controlled != sorted(b_control['mcp']):
                raise ValueError('两组实验控制的 MCP 不同')
        if (not first.get('experiment_context_fingerprint') or
                first['experiment_context_fingerprint'] != second.get('experiment_context_fingerprint')):
            raise ValueError('实验公共输入、模型或能力来源发生变化，不能只归因于能力开关')
    for key in set(left) & set(right):
        if left[key]['input_fingerprint'] != right[key]['input_fingerprint']:
            raise ValueError(f'用例输入不一致: {key}')
        a = left[key]['execution'].get('capabilities', {})
        b = right[key]['execution'].get('capabilities', {})
        if capability_comparison:
            selected = 'selected_plugins' if first['target']['type'] == 'plugin_agent' else 'selected_skills'
            for report, manifest in ((first, a), (second, b)):
                expected = report['experiment']['overrides']['capability']['enabled']
                if manifest.get('target_enabled') is not expected or bool(manifest.get(selected)) != expected:
                    raise ValueError('实际评测能力加载状态与对照声明不一致')
                if manifest.get('agent') != report['execution_config']['agent_name']:
                    raise ValueError('实际加载的 Agent 与对照配置不一致')
                if not manifest.get('host_config_fingerprint'):
                    raise ValueError('缺少宿主配置证据，无法比较')
            host_equal = a['host_config_fingerprint'] == b['host_config_fingerprint']
        elif experiments:
            for report, manifest in ((first, a), (second, b)):
                if manifest.get('mcp_comparison_servers') != controlled or not manifest.get('mcp_comparison_fingerprint'):
                    raise ValueError('缺少实验 MCP 配置证据，无法比较')
                for name in controlled:
                    server = manifest.get('mcp', {}).get(name)
                    if not isinstance(server, dict) or server.get('enabled', True) != report['experiment']['overrides']['mcp'][name]['enabled']:
                        raise ValueError(f'实际 MCP 状态与实验声明不符: {name}')
            host_equal = a['mcp_comparison_fingerprint'] == b['mcp_comparison_fingerprint']
            if (not a.get('mcp_comparison_effective_fingerprint') or
                    a['mcp_comparison_effective_fingerprint'] != b.get('mcp_comparison_effective_fingerprint')):
                raise ValueError('两组 OpenCode 实际配置不同，不能只归因于 MCP 开关')
        else:
            host_equal = a.get('host_config_fingerprint') == b.get('host_config_fingerprint')
        if not host_equal or a.get('version') != b.get('version'):
            raise ValueError('两组宿主配置或引擎版本不同，不能只归因于目标能力开关')
    if first['target']['type'] in ('harmonybot_agent', 'opencode_agent') and first['execution_config'].get('agent_name') != second['execution_config'].get('agent_name'):
        raise ValueError('直接Agent/MCP对照需要保持相同Agent')
    if first['verification_fingerprint'] != second['verification_fingerprint'] or first['scoring_fingerprint'] != second['scoring_fingerprint']:
        raise ValueError('两组评估流程或评分规则不同，不能计算效果差值')
    def execution_settings(data):
        config = dict(data['execution_config'])
        if capability_comparison or not experiments:
            config.pop('agent_name', None)
        if not experiments:
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
            **({'left_experiment': first['experiment'], 'right_experiment': second['experiment']} if experiments else {}),
            'left_summary': first['execution_summary'], 'right_summary': second['execution_summary'],
            'delta_direction': 'right-minus-left', 'aggregate': aggregate_values, 'pairs': pairs}
    root = Path(output)
    root.mkdir(parents=True, exist_ok=True)
    write_json(root / 'comparison.json', data)
    (root / 'index.html').write_text('<!doctype html><meta charset="utf-8"><title>Harmony Eval comparison</title>'
                                    '<h1>评测对比（右组减左组）</h1><pre>' + escape(json.dumps(data, ensure_ascii=False, indent=2)) + '</pre>')
    return str(root / 'index.html')

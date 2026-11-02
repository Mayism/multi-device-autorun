"""Validate and expand controlled MCP experiments."""

from copy import deepcopy
from harmonyeval.utils.paths import safe_id


def validate_experiments(task):
    if 'experiment' in task:
        raise ValueError('experiment 是运行时字段；请使用 experiments 数组')
    if 'experiments' not in task:
        return
    items = task['experiments']
    if not isinstance(items, list) or not items or len(items) > 100:
        raise ValueError('experiments 必须为非空数组，最多 100 组')
    if task['active']['execution']['engine'] != 'opencode':
        raise ValueError('MCP experiments 仅支持 engine: opencode')
    ids, servers = set(), None
    for item in items:
        if not isinstance(item, dict) or set(item) != {'id', 'overrides'}:
            raise ValueError('experiments 每组仅支持 id、overrides')
        if not isinstance(item['id'], str):
            raise ValueError('experiments.id 必须为字符串')
        name = safe_id(item['id'])
        if name in ids:
            raise ValueError(f'experiments.id 重复: {name}')
        ids.add(name)
        overrides = item['overrides']
        if not isinstance(overrides, dict) or set(overrides) != {'mcp'}:
            raise ValueError('experiments.overrides 当前仅支持 mcp')
        mcp = overrides['mcp']
        if not isinstance(mcp, dict) or not mcp:
            raise ValueError('experiments.overrides.mcp 必须为非空对象')
        for server, settings in mcp.items():
            if not isinstance(server, str) or not server.strip():
                raise ValueError('experiments MCP 名称必须为非空字符串')
            if (not isinstance(settings, dict) or set(settings) != {'enabled'}
                    or not isinstance(settings['enabled'], bool)):
                raise ValueError('experiments MCP 覆盖仅支持 enabled: true/false')
        if servers is not None and set(mcp) != servers:
            raise ValueError('所有 experiments 必须显式配置相同的 MCP 名称')
        servers = set(mcp)


def expand_experiments(task):
    if 'experiments' not in task:
        return [task]
    children = []
    for specification in task['experiments']:
        child = deepcopy(task)
        child.pop('experiments')
        child['experiment'] = deepcopy(specification)
        child['variant'] = specification['id']
        children.append(child)
    return children

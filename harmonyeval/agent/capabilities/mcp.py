"""Apply enabled flags to defined MCP servers in a private configuration."""

from copy import deepcopy


def apply_mcp_overrides(config, experiment):
    """Require real server definitions; a lone enabled flag is not an MCP server."""
    if not experiment:
        return config
    result = deepcopy(config)
    servers = result.get('mcp', {})
    for name, override in experiment['overrides'].get('mcp', {}).items():
        server = servers.get(name)
        if not isinstance(server, dict) or server.get('type') not in ('local', 'remote'):
            raise ValueError(f'experiments MCP 未定义: {name}；请在基础 OpenCode 配置中声明')
        if not server.get('url' if server['type'] == 'remote' else 'command'):
            raise ValueError(f'experiments MCP 定义缺少 url/command: {name}')
        server['enabled'] = override['enabled']
    return result

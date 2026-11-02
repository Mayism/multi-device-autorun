"""Bound the supported EvalScope version and load the benchmark bridge."""

from importlib.metadata import version


def require_evalscope():
    installed = version('evalscope')
    if not installed.startswith('1.14.'):
        raise ValueError(f'当前已验证EvalScope 1.14.x，实际安装{installed}')
    from importlib import import_module
    import_module('harmonyeval.benchmarks.evalscope')
    return installed

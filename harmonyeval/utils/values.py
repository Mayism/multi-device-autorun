"""Normalize loose protocol values without depending on reports."""
import math

def _obj(value):
    return value if isinstance(value, dict) else {}


def _list(value):
    return value if isinstance(value, list) else []


def _truthy(value):
    if isinstance(value, (dict, list)):
        return True
    return bool(value)


def _numeric(value):
    try:
        if value is None:
            return 0
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, str) and not value.strip():
            return 0
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError, OverflowError):
        return None

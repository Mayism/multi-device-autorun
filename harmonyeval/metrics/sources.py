"""Resolve scoring inputs from structured verification results."""




def source_value(results, path):
    parts = str(path).split(".")
    value = results[parts.pop(0)]
    if value.get("status") in ("unavailable", "skipped", "error"):
        raise ValueError(f"评分来源不可用: {path}")
    for part in parts:
        value = value[int(part)] if isinstance(value, list) else value[part]
    if value is None:
        raise ValueError(f"评分来源缺少证据: {path}")
    return value

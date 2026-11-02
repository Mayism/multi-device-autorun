"""Validate identifiers and enforce relative resource boundaries."""

import re
from pathlib import Path


def safe_id(value):
    value = str(value)
    if not re.fullmatch(r"[\w.-]{1,160}", value) or value in (".", ".."):
        raise ValueError(f"非法标识: {value!r}")
    return value


def inside(root, value, *, exists=False):
    root = Path(root).resolve()
    path = (root / str(value)).resolve()
    if path != root and root not in path.parents:
        raise ValueError(f"路径超出根目录: {value}")
    if exists and not path.exists():
        raise ValueError(f"路径不存在: {path}")
    return path

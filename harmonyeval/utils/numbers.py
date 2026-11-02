"""Validate finite numeric scoring inputs."""

import math


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"需要有限数值，实际为 {value!r}")
    return float(value)

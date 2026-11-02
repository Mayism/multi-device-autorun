"""Redact credential fields from persisted configuration and reports."""

import re


def redact(value, key=""):
    if re.search(r"authorization|token|secret|password|api.?key", key, re.I):
        return "[redacted]" if value else value
    if isinstance(value, dict):
        return {k: redact(v, str(k)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(v) for v in value]
    return value

"""Format UTC timestamps and safe artifact names."""

import re
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def safe_name(value):
    return re.sub(r"[^0-9A-Za-z._-]", "_", str(value))[:120] or "unnamed"

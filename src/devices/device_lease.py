"""Cross-process lease for emulator and HDC validation."""

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import time
from uuid import uuid4


def _alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except PermissionError:
        return True
    except (OSError, ValueError, TypeError):
        return False


@contextmanager
def device_lease(lock_path, owner, timeout_sec=900):
    path = Path(lock_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    token = uuid4().hex
    deadline = time.monotonic() + max(1, float(timeout_sec))
    while True:
        try:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump({"token": token, "owner": str(owner), "pid": os.getpid(),
                           "acquiredAt": datetime.now(timezone.utc).isoformat()}, stream)
            break
        except FileExistsError:
            try:
                current = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                current = None
            if not current or not _alive(current.get("pid")):
                path.unlink(missing_ok=True)
                continue
            if time.monotonic() >= deadline:
                raise TimeoutError(f"等待设备租约超时（{timeout_sec} 秒），当前持有者: {current.get('owner') or '未知'}")
            time.sleep(0.5)
    try:
        yield
    finally:
        try:
            current = json.loads(path.read_text(encoding="utf-8"))
            if current.get("token") == token:
                path.unlink(missing_ok=True)
        except (OSError, ValueError):
            pass

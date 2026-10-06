"""Format the OpenCode agent JSON file without a Node script."""

import json
from pathlib import Path
import sys


if len(sys.argv) > 1:
    target = Path(sys.argv[1])
    value = json.loads(target.read_text(encoding="utf-8"))
    target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

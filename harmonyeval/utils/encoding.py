"""Explicit UTF-8 child environments and safe text output on legacy terminals."""

import codecs
import json
import os
import sys


def python_utf8_environment(base=None):
    """Control Python children only; native tools may still use their own encoding."""
    env = dict(os.environ if base is None else base)
    env.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    return env


def decode_output(data, *, encoding=None):
    """Decode human-readable tool logs; structured protocols must specify encoding."""
    if data is None or isinstance(data, str):
        return data
    if encoding is not None:
        return data.decode(encoding)
    for candidate in ("utf-8-sig", "gb18030"):
        try:
            return data.decode(candidate)
        except UnicodeDecodeError:
            pass
    # Preserve undecodable byte values in diagnostics instead of silently dropping them.
    return data.decode("utf-8", errors="backslashreplace")


def configure_console():
    """Keep the terminal's encoding while escaping unsupported log characters."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(errors="backslashreplace")
            except (OSError, ValueError):
                pass


def console_print(*values, sep=" ", end="\n", file=None, flush=False):
    """Print human-readable diagnostics safely, also with caller-supplied streams."""
    stream = sys.stdout if file is None else file
    text = sep.join(str(value) for value in values) + end
    try:
        stream.write(text)
    except UnicodeEncodeError:
        encoding = getattr(stream, "encoding", None) or "utf-8"
        stream.write(text.encode(encoding, errors="backslashreplace").decode(encoding))
    if flush:
        stream.flush()


def print_json(value, *, file=None, **options):
    """Use JSON's own ASCII escapes on non-UTF-8 streams, preserving valid JSON."""
    stream = sys.stdout if file is None else file
    encoding = getattr(stream, "encoding", None) or "utf-8"
    options["ensure_ascii"] = codecs.lookup(encoding).name != "utf-8"
    console_print(json.dumps(value, **options), file=stream)

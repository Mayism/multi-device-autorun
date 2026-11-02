"""Remove temporary case files once the batch summary is durable."""

from pathlib import Path
import re


CASE_METADATA_FILES = ("result.json", "state.json", "session.json")
OMITTED_GENERATE_FILES = ("input.txt", "last-message.json", "skill-runtime.json",
                          "output.txt", "final-message.json")


def cleanup_case_metadata(batch_root, summary):
    root = Path(batch_root)
    if not (root / "summary.json").is_file():
        raise FileNotFoundError(root / "summary.json")
    failures = []
    names = {item.get("case") for item in summary.get("results", [])
             if isinstance(item, dict) and isinstance(item.get("case"), str) and item["case"]}
    for name in names:
        directory = re.sub(r"[^0-9A-Za-z._-]", "_", name)[:120]
        if directory in ("", ".", ".."):
            directory = "unnamed"
        case_dir = root / directory
        for relative in (*CASE_METADATA_FILES,
                         *(f"generate/{file_name}" for file_name in OMITTED_GENERATE_FILES)):
            try:
                (case_dir / relative).unlink(missing_ok=True)
            except OSError as error:
                failures.append(f"{name}/{relative}: {error}")
    return failures

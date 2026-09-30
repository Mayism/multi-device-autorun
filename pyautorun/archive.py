"""Build failure artifacts with the same paths and exclusions as the Node ZIP."""

from io import BytesIO
import os
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


EXCLUDED_DIRS = {"build", ".hvigor", "oh_modules", "node_modules", ".opencode", ".git", ".ohpm"}
EXCLUDED_FILES = {"opencode.json", "oh-package-lock.json5"}


def _excluded(name: str) -> bool:
    parts = name.replace("\\", "/").split("/")
    if any(part in EXCLUDED_DIRS or part == "__pycache__" for part in parts):
        return True
    if parts[-1] in EXCLUDED_FILES or parts[-1].lower().endswith(".pyc"):
        return True
    return any(part == "evidence" and parts[index + 1] == "tmp" for index, part in enumerate(parts[:-1]))


def _walk(directory: Path, prefix: str, excluded_paths: set[Path]):
    try:
        with os.scandir(directory) as listing:
            entries = sorted(listing, key=lambda entry: entry.name)
    except OSError:
        return
    for entry in entries:
        entry_path = Path(entry.path)
        if entry_path.resolve() in excluded_paths:
            continue
        name = f"{prefix}/{entry.name}" if prefix else entry.name
        if _excluded(name):
            continue
        if entry.is_dir(follow_symlinks=False):
            yield from _walk(entry_path, name, excluded_paths)
        elif entry.is_file(follow_symlinks=False):
            yield entry_path, name


def create_zip(payload: dict) -> bytes:
    excluded_paths = {Path(value).resolve() for value in payload.get("excludeAbsPaths", [])}
    files = []
    for source in payload["sources"]:
        if source.get("dirPath"):
            files.extend(_walk(Path(source["dirPath"]), source.get("prefix") or "", excluded_paths))
        elif source.get("absPath") and not _excluded(source["zipPath"]):
            source_path = Path(source["absPath"])
            if source_path.resolve() not in excluded_paths:
                files.append((source_path, source["zipPath"]))

    result = BytesIO()
    with ZipFile(result, "w") as archive:
        for source_path, archive_path in files:
            info = ZipInfo(archive_path, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            archive.writestr(info, source_path.read_bytes())
    return result.getvalue()

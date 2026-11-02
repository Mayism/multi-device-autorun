"""Copy a case to its isolated Python-managed workspace."""

import os
from pathlib import Path
import shutil


COPY_EXCLUDES = {".git", ".opencode", ".claude", ".agents", ".hvigor", "node_modules", "build"}


def _inside(root, candidate):
    relative = os.path.relpath(candidate, root)
    if relative == ".." or relative.startswith(".." + os.sep) or os.path.isabs(relative):
        return None
    return relative


def copy_project(source_root, target_root):
    """Copy files and remap links into target_root; reject external links."""
    source = Path(os.path.abspath(source_root))
    target = Path(os.path.abspath(target_root))
    if not source.is_dir():
        raise ValueError(f"用例目录不存在: {source}")
    if _inside(source, target) is not None or _inside(target, source) is not None:
        raise ValueError(f"用例目录和目标目录不能互相包含: {source} -> {target}")
    links = []
    if target.exists() or target.is_symlink():
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink()
    target.mkdir(parents=True)

    for current, dirs, files in os.walk(source, followlinks=False):
        current_path = Path(current)
        relative_dir = current_path.relative_to(source)
        destination_dir = target / relative_dir
        destination_dir.mkdir(parents=True, exist_ok=True)
        entries = [*dirs, *files]
        dirs[:] = [name for name in dirs if name not in COPY_EXCLUDES and
                   not (current_path / name).is_symlink()]
        for name in entries:
            if name in COPY_EXCLUDES:
                continue
            entry = current_path / name
            destination = destination_dir / name
            if entry.is_symlink():
                link_target = os.readlink(entry)
                resolved = os.path.abspath(os.path.join(current, link_target))
                relative_target = _inside(source, resolved)
                if relative_target is None:
                    raise ValueError(f"拒绝复制指向用例目录外部的链接: {entry} -> {resolved}")
                try:
                    is_directory = entry.is_dir()
                    if not entry.exists():
                        raise OSError("链接目标不存在")
                except OSError as error:
                    raise ValueError(f"无法解析链接目标: {entry} -> {resolved}") from error
                links.append((entry, destination, relative_target, is_directory))
            elif entry.is_file():
                shutil.copy2(entry, destination)

    pending = links
    while pending:
        next_round = []
        created = 0
        for entry, destination, relative_target, is_directory in pending:
            mapped = target / relative_target
            destination.parent.mkdir(parents=True, exist_ok=True)
            if os.name == "nt" and not mapped.exists():
                next_round.append((entry, destination, relative_target, is_directory))
                continue
            if os.name == "nt" and not is_directory:
                shutil.copy2(mapped, destination)
            else:
                relative_link = os.path.relpath(mapped, destination.parent)
                destination.symlink_to(relative_link, target_is_directory=is_directory)
            created += 1
        if next_round and not created:
            unresolved = ", ".join(os.path.relpath(entry, source) for entry, *_ in next_round)
            raise ValueError(f"无法在沙箱内重建链接，目标不存在或形成循环: {unresolved}")
        pending = next_round
    return {"linksRemapped": len(links)}

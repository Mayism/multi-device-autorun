"""Read-only source snapshot for whitebox OpenCode agents."""

import json
import os
from pathlib import Path
import shutil

from .whitebox_rule_evidence import _ignored_case_file


SKIP = {".env", ".git", "node_modules", "oh_modules", ".hvigor", "build", "dist"}


def _copy_tree(source, target):
    source = Path(source).resolve()
    target = Path(target)
    target.mkdir(parents=True, exist_ok=True)
    for current, directories, files in os.walk(source, followlinks=False):
        current_path = Path(current)
        relative_dir = current_path.relative_to(source)
        directories[:] = [name for name in directories if name not in SKIP and not name.startswith(".env.")
                          and not (current_path / name).is_symlink()]
        for name in files:
            relative = (relative_dir / name).as_posix()
            if name in SKIP or name.startswith(".env.") or _ignored_case_file(relative):
                continue
            path = current_path / name
            if path.is_symlink():
                try:
                    path.resolve(strict=True).relative_to(source)
                except (OSError, ValueError):
                    continue
            elif not path.is_file():
                continue
            output = target / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, output)


def build_sandbox(case_dir, generated_project_path, original_project_path=None,
                  original_project_provided=True, effective_patch_path=None, metadata=None):
    root = Path(case_dir) / "opencode-sandbox"
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    generated = root / "generated"
    _copy_tree(generated_project_path, generated)
    original = root / "original"
    copied_original = None
    if original_project_provided and original_project_path and Path(original_project_path).exists():
        _copy_tree(original_project_path, original)
        copied_original = str(original)
    copied_patch = None
    if effective_patch_path and Path(effective_patch_path).is_file():
        patch = root / "patch" / "effective.patch"
        patch.parent.mkdir(parents=True)
        shutil.copyfile(effective_patch_path, patch)
        copied_patch = str(patch)
    metadata_root = root / "metadata"
    metadata_root.mkdir(parents=True)
    (metadata_root / "metadata.json").write_text(
        json.dumps(metadata or {}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"root": str(root), "generatedRoot": str(generated), "originalRoot": copied_original,
            "patchPath": copied_patch, "metadataRoot": str(metadata_root)}

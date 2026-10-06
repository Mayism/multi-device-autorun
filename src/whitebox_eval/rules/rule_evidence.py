"""Collect whitebox source and patch evidence without Node filesystem helpers."""

import os
from pathlib import Path
import re


BUILTIN_NAMES = {".git", ".gitignore", ".agent_bench", ".DS_Store", ".hvigor",
                 "__MACOSX", "build", "node_modules", "oh_modules", "oh-package-lock.json5"}
RULE_IGNORED_PREFIXES = ("entry/src/test", "entry/src/ohosTest")
RULE_IGNORED_PATTERN = re.compile(r"(?:^|/)src/(?:test|ohosTest)(?:/|$)")


def _read_text(path):
    return Path(path).read_bytes().decode("utf-8", errors="replace")


def _ignored_case_file(path):
    normalized = re.sub(r"^\./+", "", path.replace("\\", "/"))
    parts = [part for part in normalized.split("/") if part]
    name = parts[-1] if parts else path
    return (name == "BuildProfile.ets" or ".onemulti" in parts or "__pycache__" in parts or
            name.lower().endswith(".pyc") or
            any(part == "evidence" and index + 1 < len(parts) and parts[index + 1] == "tmp"
                for index, part in enumerate(parts)))


def _ignore_rules(root):
    try:
        lines = re.split(r"\r?\n", _read_text(Path(root) / ".gitignore"))
    except OSError:
        return []
    rules = []
    for line in lines:
        pattern = line.strip()
        if not pattern or pattern.startswith(("#", "!")) or "**" in pattern:
            continue
        directory_only = pattern.endswith("/")
        normalized = pattern[:-1] if directory_only else pattern
        if not normalized:
            continue
        if pattern.startswith("*."):
            rules.append(("suffix", pattern[1:]))
        elif "*" in normalized:
            regex = re.compile("^" + re.escape(normalized).replace(r"\*", "[^/]*") + "$")
            rules.append(("wildcard", regex, "/" in normalized, directory_only))
        elif directory_only:
            rules.append(("prefix", normalized))
        else:
            rules.append(("exact", pattern))
    return rules


def _matches_rule(rule, relative, directory):
    kind = rule[0]
    segments = relative.split("/")
    if kind == "suffix":
        return not directory and relative.endswith(rule[1])
    if kind == "prefix":
        return relative == rule[1] or relative.startswith(rule[1] + "/") or rule[1] in segments
    if kind == "exact":
        return relative == rule[1] or rule[1] in segments
    _, pattern, has_slash, directory_only = rule
    if directory_only:
        dirs = segments if directory else segments[:-1]
        if has_slash:
            return any(pattern.search("/".join(dirs[:index])) for index in range(1, len(dirs) + 1))
        return any(pattern.search(segment) for segment in dirs)
    return bool(pattern.search(relative)) if has_slash else any(pattern.search(segment) for segment in segments)


def _ignored(relative, directory, rules):
    segments = relative.split("/")
    directory_segments = segments if directory else segments[:-1]
    if any(part.startswith(".") for part in directory_segments):
        return True
    if any(part == "src" and index + 1 < len(directory_segments) and
           directory_segments[index + 1] in ("test", "ohosTest")
           for index, part in enumerate(directory_segments)):
        return True
    if any(part in BUILTIN_NAMES for part in segments):
        return True
    if not directory and (any(part.startswith("._") for part in segments) or _ignored_case_file(relative)):
        return True
    if any(relative == prefix or relative.startswith(prefix + "/") for prefix in RULE_IGNORED_PREFIXES):
        return True
    if not directory and relative.endswith(".log"):
        return True
    return any(_matches_rule(rule, relative, directory) for rule in rules)


def _visible_files(root):
    root = Path(root)
    rules = _ignore_rules(root)
    files = []

    def visit(directory):
        for entry in os.scandir(directory):
            relative = Path(entry.path).relative_to(root).as_posix()
            directory_entry = entry.is_dir(follow_symlinks=False)
            if _ignored(relative, directory_entry, rules):
                continue
            if directory_entry:
                visit(entry.path)
            elif entry.is_file(follow_symlinks=False) and not RULE_IGNORED_PATTERN.search(relative):
                files.append(relative)

    visit(root)
    return sorted(files)


def _patch_line_ignored(line):
    match = re.match(r"^diff --git a/(.+?) b/(.+)$", line)
    if match:
        return any(_ignored_case_file(item) for item in match.groups())
    match = re.match(r"^(?:---|\+\+\+) (?:a|b)/(.+)$", line)
    return bool(match and _ignored_case_file(match.group(1)))


def _filter_patch(patch):
    if "diff --git" not in patch:
        return patch
    trailing = patch.endswith("\n")
    lines = patch[:-1].split("\n") if trailing else patch.split("\n")
    sections = []
    current = []
    ignored = False
    for line in lines:
        if line.startswith("diff --git ") and current:
            sections.append((current, ignored))
            current, ignored = [], False
        current.append(line)
        ignored = ignored or _patch_line_ignored(line)
    if current:
        sections.append((current, ignored))
    kept = [line for section, excluded in sections if not excluded for line in section]
    return ("\n".join(kept) + ("\n" if trailing else "")) if kept else ""


def _patch_scope(patch):
    changed = []
    lines_by_file = {}
    if not patch:
        return changed, lines_by_file
    current = None
    next_line = None

    def register(relative):
        nonlocal current
        if not relative or relative == "/dev/null":
            return
        normalized = re.sub(r"^(?:workspace|original)/", "", relative)
        if not normalized or _ignored_case_file(normalized):
            current = None
            return
        current = normalized
        if normalized not in lines_by_file:
            changed.append(normalized)
            lines_by_file[normalized] = []

    for line in re.split(r"\r?\n", patch):
        match = re.match(r"^diff --git a/.+? b/(.+)$", line)
        if match:
            register(match.group(1))
            next_line = None
            continue
        match = re.match(r"^\+\+\+ b/(.+)$", line)
        if match:
            register(match.group(1))
            continue
        match = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@", line)
        if match:
            next_line = int(match.group(1))
            continue
        if current is None or next_line is None:
            continue
        if line.startswith("+") and not line.startswith("+++"):
            lines_by_file[current].append(next_line)
            next_line += 1
        elif line.startswith("-") and not line.startswith("---"):
            continue
        elif not line.startswith("\\"):
            next_line += 1
    return changed, lines_by_file


def _case_dir(case_input):
    patch = case_input.get("patchPath")
    if patch:
        path = Path(patch)
        if path.parent.name in ("diff", "intermediate"):
            return str(path.parent.parent)
        if path.parent.name == "patch" and path.parent.parent.name == "opencode-sandbox":
            return str(path.parent.parent.parent)
    generated = Path(case_input["generatedProjectPath"])
    if generated.name == "workspace":
        return str(generated.parent)
    if generated.name == "generated" and generated.parent.name == "opencode-sandbox":
        return str(generated.parent.parent)
    return None


def collect_rule_evidence(case_input):
    workspace_root = Path(case_input["generatedProjectPath"])
    all_paths = _visible_files(workspace_root)
    try:
        original_paths = _visible_files(case_input["originalProjectPath"])
    except OSError:
        original_paths = []
    patch = None
    try:
        if case_input.get("patchPath"):
            patch = _filter_patch(_read_text(case_input["patchPath"]))
    except OSError:
        pass
    changed, added_lines = _patch_scope(patch)
    limited = bool(changed)
    all_files = []
    for relative in all_paths:
        file = {"relativePath": relative, "content": _read_text(workspace_root / relative)}
        if limited:
            file["patchLineNumbers"] = added_lines.get(relative, [])
        all_files.append(file)
    workspace = [file for file in all_files if file["relativePath"] in changed] if limited else all_files
    summary = {"workspaceFileCount": len(workspace), "originalFileCount": len(original_paths),
               "changedFileCount": len(changed), "changedFiles": changed,
               "changedLineNumbersByFile": added_lines, "hasPatch": bool(patch)}
    result = {"workspaceFiles": workspace, "allWorkspaceFiles": all_files,
              "originalFiles": original_paths, "changedFiles": changed, "summary": summary}
    if patch is not None:
        result["patchText"] = patch
    case_dir = _case_dir(case_input)
    if case_dir is not None:
        result["caseDir"] = case_dir
    return result

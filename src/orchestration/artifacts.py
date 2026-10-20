"""Git baselines, filtered patches and transient artifact cleanup."""

from pathlib import Path
import re
import shutil
import subprocess


GIT_EXCLUDES = (".onemulti/", ".hvigor/", "oh_modules/", "build/", "node_modules/",
                "local.properties", "oh-package-lock.json5", "/layout_[0-9]*.json", "/screenshots/",
                "__pycache__/", "*.pyc", "**/evidence/tmp/")
BUILD_DIRS = {".git", ".hvigor", "build", "node_modules"}


def _parts(relative):
    return [part for part in str(relative).replace("\\", "/").lstrip("./").split("/") if part]


def excluded(relative):
    parts = _parts(relative)
    return (any(part in parts for part in (".onemulti", ".hvigor", "oh_modules", "build",
                                          "node_modules", "__pycache__")) or
            bool(parts and parts[-1] == "local.properties") or
            bool(parts and parts[-1] == "oh-package-lock.json5") or
            bool(len(parts) == 1 and re.fullmatch(r"layout_\d+\.json", parts[0])) or
            bool(parts and parts[0] == "screenshots") or
            bool(parts and parts[-1].lower().endswith(".pyc")) or
            any(parts[index:index + 2] == ["evidence", "tmp"] for index in range(len(parts) - 1)))


def prunable(relative):
    parts = _parts(relative)
    return ("__pycache__" in parts or bool(parts and parts[-1].lower().endswith(".pyc")) or
            any(parts[index:index + 2] == ["evidence", "tmp"] for index in range(len(parts) - 1)))


def filter_patch(patch):
    if "diff --git" not in patch:
        return patch
    sections = re.split(r"(?=^diff --git )", patch, flags=re.M)
    kept = []
    for section in sections:
        if not section:
            continue
        references = re.findall(r"^diff --git a/(.+?) b/(.+)$", section, flags=re.M)
        markers = re.findall(r"^(?:---|\+\+\+) (?:a|b)/(.+)$", section, flags=re.M)
        paths = [path for pair in references for path in pair] + markers
        empty_root_layout = ("diff --git a/layout.json b/layout.json" in section and
                             "new file mode 100644" in section and "index 0000000..e69de29" in section)
        if not empty_root_layout and not any(excluded(path) for path in paths):
            kept.append(section)
    return "".join(kept)


def _git(project_dir, *args, check=True):
    result = subprocess.run(["git", *args], cwd=project_dir, capture_output=True, check=False)
    if check and result.returncode:
        raise RuntimeError(f"git {' '.join(args)} 执行失败({result.returncode}): " +
                           result.stderr.decode("utf-8", errors="replace"))
    return result


def initialize_git_baseline(project_dir):
    project = Path(project_dir)
    _git(project, "init")
    _git(project, "config", "user.name", "autorun")
    _git(project, "config", "user.email", "autorun@example.local")
    with (project / ".git" / "info" / "exclude").open("a", encoding="utf-8") as stream:
        stream.write("\n.opencode/\nnode_modules/\nbuild/\n" + "\n".join(GIT_EXCLUDES) + "\n")
    _git(project, "add", "-A", "--", ".")
    _git(project, "commit", "--allow-empty", "-m", "autorun project baseline")
    return _git(project, "rev-parse", "HEAD").stdout.decode().strip()


def generate_patch(project_dir, baseline, patch_path):
    _git(project_dir, "add", "-A", "--", ".")
    changed = _git(project_dir, "diff", "--cached", "--name-only", "-z", baseline).stdout
    for relative_bytes in filter(None, changed.split(b"\0")):
        relative = relative_bytes.decode("utf-8", errors="surrogateescape")
        if Path(relative).name != "BuildProfile.ets":
            continue
        original = _git(project_dir, "show", f"{baseline}:{relative}", check=False)
        if original.returncode:
            continue
        source = Path(project_dir) / relative
        if not source.is_file():
            continue
        current = source.read_text(encoding="utf-8")
        pattern = re.compile(r"^export const BUILD_MODE_NAME = '([^']+)';$", re.M)
        before = pattern.search(original.stdout.decode("utf-8"))
        after = pattern.search(current)
        if not before or before.group(1) != "test" or not after or after.group(1) != "debug":
            continue
        sanitized = pattern.sub("export const BUILD_MODE_NAME = 'test';", current, count=1)
        staged = _git(project_dir, "ls-files", "--stage", "-z", "--", relative).stdout
        mode = re.match(rb"(\d{6}) [0-9a-f]+ 0\t", staged)
        if not mode:
            raise RuntimeError(f"无法读取 {relative} 的 Git 文件模式")
        blob = subprocess.run(["git", "hash-object", "-w", "--stdin"], cwd=project_dir,
                              input=sanitized.encode("utf-8"), capture_output=True, check=True).stdout.decode().strip()
        _git(project_dir, "update-index", "--cacheinfo", f"{mode.group(1).decode()},{blob},{relative}")
    result = _git(project_dir, "diff", "--cached", "--binary", baseline, check=False)
    if result.returncode not in (0, 1):
        raise RuntimeError("生成 patch 失败: " + result.stderr.decode("utf-8", errors="replace"))
    target = Path(patch_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(filter_patch(result.stdout.decode("utf-8", errors="replace")), encoding="utf-8")


def _remove(path):
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def prune_project(root, build_dirs=False):
    root = Path(root)
    if not root.exists():
        return []
    removed = []
    def visit(directory):
        for child in directory.iterdir():
            relative = child.relative_to(root).as_posix()
            if prunable(relative) or (build_dirs and child.is_dir() and child.name in BUILD_DIRS):
                _remove(child)
                removed.append(relative)
            elif child.is_dir() and not child.is_symlink():
                visit(child)
    visit(root)
    return removed


def cleanup_case(case_name, original_dir, project_dir, patch_path, generate_dir,
                 remove_raw_logs=False, prune_build=False, keep_original=False):
    failures = []
    actions = []
    if not keep_original and Path(patch_path).exists():
        actions.append(("删除 original", lambda: _remove(Path(original_dir))))
    if remove_raw_logs:
        for name in ("opencode-sse.jsonl", "opencode-polling.jsonl"):
            actions.append((f"删除 {name}", lambda name=name: _remove(Path(generate_dir) / name)))
    actions.append(("清理 Agent 临时产物", lambda: prune_project(project_dir, build_dirs=prune_build)))
    for label, action in actions:
        try:
            action()
        except OSError as error:
            failures.append(f"{label}: {error}")
    if failures:
        with (Path(generate_dir) / "cleanup-errors.log").open("a", encoding="utf-8") as stream:
            stream.write(f"{case_name}: {'；'.join(failures)}\n")

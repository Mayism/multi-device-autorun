"""Prepare the effective whitebox patch from explicit input or two project trees."""

from pathlib import Path
import shutil
import subprocess
import tempfile

from pyautorun.whitebox_eval.rules.rule_evidence import _filter_patch, _visible_files


def generate_project_patch(original, generated, output):
    original = Path(original).resolve()
    generated = Path(generated).resolve()
    output = Path(output)
    if not original.is_dir() or not generated.is_dir():
        raise ValueError("原始或生成工程目录不存在")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="case-patch-") as temp:
        root = Path(temp)
        for source, name in ((original, "original"), (generated, "workspace")):
            for relative in _visible_files(source):
                destination = root / name / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source / relative, destination)
        (root / "original").mkdir(exist_ok=True)
        (root / "workspace").mkdir(exist_ok=True)
        run = subprocess.run(["git", "diff", "--no-index", "--no-ext-diff", "--",
                              "original", "workspace"], cwd=root, capture_output=True, check=False)
        if run.returncode not in (0, 1):
            raise RuntimeError("生成白盒补丁失败: " + run.stderr.decode("utf-8", errors="replace"))
        text = _filter_patch(run.stdout.decode("utf-8", errors="replace"))
    output.write_text(text, encoding="utf-8")
    return str(output)


def ensure_effective_patch(case_input, case_dir):
    target_dir = Path(case_dir) / "intermediate"
    target_dir.mkdir(parents=True, exist_ok=True)
    given = case_input.get("patchPath")
    if given:
        try:
            text = _filter_patch(Path(given).read_text(encoding="utf-8"))
        except OSError:
            text = ""
        if text.strip():
            target = target_dir / "effective.patch"
            target.write_text(text, encoding="utf-8")
            return str(target)
    original = Path(case_input["originalProjectPath"])
    original.mkdir(parents=True, exist_ok=True)
    return generate_project_patch(original, case_input["generatedProjectPath"],
                                  target_dir / ("effective.patch" if given else "generated.patch"))

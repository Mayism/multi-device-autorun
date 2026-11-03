"""Initialize project baselines and export filtered agent changes."""

from pathlib import Path


def init_project(workspace):
    from harmonyeval.utils.git import initialize_git_baseline
    baseline = initialize_git_baseline(workspace)
    with (Path(workspace) / ".git/info/exclude").open("a", encoding="utf-8") as stream:
        stream.write("\n.claude/\n.agents/\n.ohos-adaptation/\n.ohostest-runs/\n")
    return baseline


def save_patch(workspace, output, baseline):
    from harmonyeval.utils.git import generate_patch
    generate_patch(workspace, baseline, Path(output) / "change.patch")

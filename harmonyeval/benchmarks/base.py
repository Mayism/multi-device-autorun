"""Prepare public case inputs and fingerprint private grading evidence."""

import shutil
from pathlib import Path
from harmonyeval.utils.paths import inside
from harmonyeval.utils.hashes import fingerprint, file_fingerprint


IGNORE = shutil.ignore_patterns(".git", "node_modules", ".hvigor", ".ohpm", "build", "oh_modules",
                                ".ohos-adaptation", ".ohostest-runs", ".opencode", ".claude", ".agents")


class DatasetAdapter:
    version = "2"

    def archive_evidence(self, case, output):
        """Archive evaluator-only inputs after the agent has stopped."""
        return {}

    def project_path(self, case, workspace):
        return Path(workspace)

    def prepare(self, case, workspace):
        workspace = Path(workspace)
        workspace.mkdir(parents=True, exist_ok=True)
        if not case.project:
            return str(workspace)
        protected = [inside(case.root, value) for key, value in case.expected.items()
                     if key in ("tests", "api_mapping", "test_patch", "golden_patch") and isinstance(value, str)]
        def ignore(directory, names):
            skipped = set(IGNORE(directory, names))
            for name in names:
                path = (Path(directory) / name).resolve()
                if ((Path(directory).resolve() == Path(case.root).resolve() and name in ("case.yaml", "metadata.json"))
                        or any(path == p or p in path.parents for p in protected)):
                    skipped.add(name)
            return skipped
        template = case.metadata.get("target_template")
        if template:
            shutil.copytree(case.project, workspace.parent / "input", dirs_exist_ok=True, ignore=ignore)
            shutil.copytree(template, workspace, dirs_exist_ok=True, ignore=IGNORE)
        else:
            shutil.copytree(case.project, workspace, dirs_exist_ok=True, ignore=ignore)
        return str(workspace)

    def fingerprint(self, case):
        entries = []
        root = Path(case.project) if case.project else None
        if root is None:
            return fingerprint({"id": case.case_id, "question": case.question})
        for p in sorted(root.rglob("*")):
            if not p.is_file() or any(x in p.relative_to(root).parts for x in (".git", "node_modules", "build", ".hvigor", "oh_modules")):
                continue
            if p.name in ("case.yaml", "metadata.json") and p.parent == Path(case.root):
                continue
            protected = [inside(case.root, value) for key, value in case.expected.items()
                         if key in ("tests", "api_mapping", "test_patch", "golden_patch") and isinstance(value, str)]
            if any(p == path or path in p.parents for path in protected):
                continue
            entries.append((str(p.relative_to(root)), file_fingerprint(p)))
        template = case.metadata.get("target_template")
        template_files = [(str(p.relative_to(template)), file_fingerprint(p))
                          for p in sorted(Path(template).rglob("*")) if p.is_file() and
                          not any(part in (".git", "node_modules", "build", ".hvigor", "oh_modules")
                                  for part in p.relative_to(template).parts)] if template else []
        return fingerprint({"id": case.case_id, "question": case.question,
                            "files": entries, "template_files": template_files})

    def evidence_fingerprint(self, case):
        entries = []
        for key, value in case.expected.items():
            if key not in ("reference_documents", "tests", "test_patch", "golden_patch", "api_mapping"):
                continue
            values = value if isinstance(value, list) else [value]
            for item in values:
                if not isinstance(item, str):
                    continue
                path = inside(case.root, item)
                files = sorted(path.rglob("*")) if path.is_dir() else [path]
                for p in files:
                    if p.is_file():
                        entries.append((str(p), file_fingerprint(p)))
        return fingerprint({"expected": case.expected, "metadata": case.metadata, "evidence": entries})


def select(cases, config):
    ids = [case.case_id for case in cases]
    if len(ids) != len(set(ids)):
        raise ValueError("数据集 case_id 重复")
    selected = config.get("case_ids")
    if selected:
        missing = set(selected) - set(ids)
        if missing:
            raise ValueError(f"未找到用例: {sorted(missing)}")
        cases = [case for case in cases if case.case_id in selected]
    if config.get("limit"):
        cases = cases[:config["limit"]]
    if not cases:
        raise ValueError(f"数据集没有有效用例: {config['dir']}")
    return cases

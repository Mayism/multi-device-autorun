"""Public task inputs and evaluator-only references have separate lifetimes."""

from pathlib import Path
import json
import shutil

from pyautorun.harmony_eval.config import read_yaml
from pyautorun.harmony_eval.core import EvalCase, datasets, inside, safe_id, fingerprint, file_fingerprint


IGNORE = shutil.ignore_patterns(".git", "node_modules", ".hvigor", ".ohpm", "build", "oh_modules",
                                ".ohos-adaptation", ".ohostest-runs", ".opencode", ".claude", ".agents")


class DatasetAdapter:
    version = "2"

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


@datasets.register("swe-bench-hm-multi-dev")
class MultiDevDataset(DatasetAdapter):
    def project_path(self, case, workspace):
        if case.metadata.get("platform") == "web":
            native = case.metadata["native"]
            name = native.get("base_project") or next(
                n for n in ("base", "task") if (Path(case.root) / n).is_dir())
            return inside(workspace, name)
        return super().project_path(case, workspace)

    def load(self, config):
        root = Path(config["dir"])
        cases = []
        for folder in sorted(p for p in root.iterdir() if p.is_dir()):
            project = next((folder / n for n in ("base", "task") if (folder / n).is_dir()), None)
            if project is None or not (folder / "PROMPT.md").is_file():
                continue
            metadata = json.loads((folder / "metadata.json").read_text()) if (folder / "metadata.json").exists() else {}
            case_id = safe_id(metadata.get("case_id") or folder.name)
            expected = {key: metadata[key] for key in ("test_patch", "golden_patch") if metadata.get(key)}
            if metadata.get("platform") == "web":
                project = folder
            cases.append(EvalCase(case_id, (folder / "PROMPT.md").read_text(), str(folder),
                                  str(project), expected, {"platform": metadata.get("platform", "native"),
                                                          "native": metadata}))
        return select(cases, config)


@datasets.register("library-migration")
@datasets.register("android-migration")
class MigrationDataset(DatasetAdapter):
    @staticmethod
    def expected(value):
        if any(key in value for key in ("output_kind", "output_project")):
            raise ValueError("expected.output_kind/output_project 已取消；产物类型由任务提示词确定，工程统一写入用例的 base/ 目录")
        return dict(value)

    @staticmethod
    def instruction(text, has_template=False):
        source = "原工程副本位于 ../input/，当前目录已准备目标工程模板。" if has_template else "当前目录已准备原工程副本，可按转换需要修改或重建工程。"
        return text + "\n\n[评测工程目录约定]\n" + source + "最终目标工程的根目录必须是当前工作目录（本用例的 base/），不要另建 generated/ 等目录作为工程根目录。"

    def load(self, config):
        root = Path(config["dir"])
        if config.get("layout") == "repositories":
            instruction = config.get("instruction")
            if not isinstance(instruction, str) or not instruction.strip():
                raise ValueError("repositories布局需要dataset.instruction公开任务要求")
            markers = ("pubspec.yaml", "package.json", "build.gradle", "build.gradle.kts", "settings.gradle")
            projects = [root] if any((root / marker).is_file() for marker in markers) else sorted(
                p for p in root.iterdir() if p.is_dir() and not p.name.startswith("."))
            expected = self.expected(config.get("expected", {}))
            cases = [EvalCase(safe_id(p.name), self.instruction(instruction), str(p), str(p),
                              dict(expected),
                              {"verification": config.get("verification", {}), "source_format": config["type"]})
                     for p in projects]
            return select(cases, config)
        if config.get("layout", "cases") != "cases":
            raise ValueError("迁移数据集layout支持cases/repositories")
        paths = [root / "case.yaml"] if (root / "case.yaml").is_file() else sorted(root.glob("*/case.yaml"))
        cases = []
        for path in paths:
            raw = read_yaml(path)
            folder = path.parent
            project = inside(folder, raw["input"]["project"], exists=True)
            instruction = self.instruction(inside(folder, raw["input"]["instruction"], exists=True).read_text(),
                                           bool(raw["input"].get("target_template")))
            expected = self.expected(raw.get("expected", {}))
            meta = {"verification": raw.get("verification", {}), "source_format": config["type"]}
            if raw["input"].get("target_template"):
                meta["target_template"] = str(inside(folder, raw["input"]["target_template"], exists=True))
            cases.append(EvalCase(safe_id(raw.get("id") or folder.name), instruction, str(folder),
                                  str(project), expected, meta))
        return select(cases, config)


@datasets.register("text-qa")
class TextDataset(DatasetAdapter):
    def load(self, config):
        root = Path(config["dir"])
        paths = [root] if root.is_file() else sorted(root.glob("*.jsonl"))
        cases = []
        for path in paths:
            for index, line in enumerate(path.read_text().splitlines(), 1):
                if not line.strip():
                    continue
                raw = json.loads(line)
                if not isinstance(raw.get("question"), str) or not raw["question"].strip():
                    raise ValueError(f"缺少 question: {path}:{index}")
                if "reference_answers" in raw and (not isinstance(raw["reference_answers"], list) or
                                                     not all(isinstance(x, str) for x in raw["reference_answers"])):
                    raise ValueError(f"reference_answers必须是字符串数组: {path}:{index}")
                cases.append(EvalCase(safe_id(raw["id"]), raw["question"], str(path.parent),
                                      expected={k: raw[k] for k in ("reference_answers", "criteria", "reference_documents") if k in raw},
                                      metadata={"input_file": str(path), "line": index}))
        return select(cases, config)

    def fingerprint(self, case):
        return fingerprint({"id": case.case_id, "question": case.question})


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

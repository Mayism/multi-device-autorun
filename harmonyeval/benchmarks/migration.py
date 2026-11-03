"""Load library and Android migration datasets."""

from pathlib import Path
from harmonyeval.config.loader import read_yaml
from harmonyeval.api.contracts import EvalCase
from harmonyeval.api.registry import datasets
from harmonyeval.utils.paths import inside, safe_id
from harmonyeval.benchmarks.base import DatasetAdapter, select


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
            instruction = self.instruction(inside(folder, raw["input"]["instruction"], exists=True).read_text(encoding="utf-8"),
                                           bool(raw["input"].get("target_template")))
            expected = self.expected(raw.get("expected", {}))
            meta = {"verification": raw.get("verification", {}), "source_format": config["type"]}
            if raw["input"].get("target_template"):
                meta["target_template"] = str(inside(folder, raw["input"]["target_template"], exists=True))
            cases.append(EvalCase(safe_id(raw.get("id") or folder.name), instruction, str(folder),
                                  str(project), expected, meta))
        return select(cases, config)

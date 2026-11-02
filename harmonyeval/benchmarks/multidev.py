"""Load multi-device engineering cases and archive evaluation references."""

import json
import shutil
from pathlib import Path
from harmonyeval.api.contracts import EvalCase
from harmonyeval.api.registry import datasets
from harmonyeval.utils.paths import inside, safe_id
from harmonyeval.benchmarks.base import DatasetAdapter, select


@datasets.register("swe-bench-hm-multi-dev")
class MultiDevDataset(DatasetAdapter):
    def archive_evidence(self, case, output):
        output = Path(output)
        output.mkdir(parents=True, exist_ok=True)
        artifacts = {}
        metadata = inside(case.root, "metadata.json")
        if metadata.is_file():
            destination = output / "metadata.json"
            shutil.copy2(metadata, destination)
            artifacts["metadata"] = str(destination)
        for key in ("test_patch", "golden_patch"):
            relative = case.expected.get(key)
            if relative:
                source = inside(case.root, relative, exists=True)
                destination = inside(output, relative)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
                artifacts[key] = str(destination)
        return artifacts

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

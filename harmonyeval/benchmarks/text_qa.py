"""Load JSON and JSONL questions while keeping reference answers private."""

import json
from pathlib import Path
from harmonyeval.api.contracts import EvalCase
from harmonyeval.api.registry import datasets
from harmonyeval.utils.paths import safe_id
from harmonyeval.utils.hashes import fingerprint
from harmonyeval.benchmarks.base import DatasetAdapter, select


@datasets.register("text-qa")
class TextDataset(DatasetAdapter):
    version = "3"

    @staticmethod
    def read_cases(path):
        if path.suffix.lower() == ".json":
            raw = json.loads(path.read_text(encoding="utf-8"))
            rows = raw.get("cases") if isinstance(raw, dict) else raw
            if not isinstance(rows, list):
                raise ValueError(f"JSON问答数据需要数组或含 cases 数组的对象: {path}")
            return [(row, {"input_file": str(path), "item_index": index})
                    for index, row in enumerate(rows, 1)]
        return [(json.loads(line), {"input_file": str(path), "line": index})
                for index, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1) if line.strip()]

    def load(self, config):
        root = Path(config["dir"])
        paths = [root] if root.is_file() else sorted(
            path for path in root.iterdir() if path.is_file() and path.suffix.lower() in (".json", ".jsonl"))
        cases = []
        for path in paths:
            for raw, location in self.read_cases(path):
                if not isinstance(raw, dict):
                    raise ValueError(f"问答用例必须是对象: {location}")
                if not isinstance(raw.get("id"), str) or not raw["id"].strip():
                    raise ValueError(f"问答用例需要非空字符串 id: {location}")
                if not isinstance(raw.get("question"), str) or not raw["question"].strip():
                    raise ValueError(f"缺少 question: {location}")
                if "reference_answer" in raw:
                    answer = raw["reference_answer"]
                    if not isinstance(answer, str) or not answer.strip():
                        raise ValueError(f"reference_answer必须是非空字符串: {location}")
                    if "reference_answers" in raw and raw["reference_answers"] != [answer]:
                        raise ValueError(f"reference_answer与reference_answers冲突，请只保留一种: {location}")
                    raw = {**raw, "reference_answers": [answer]}
                if "reference_answers" in raw and (not isinstance(raw["reference_answers"], list) or
                                                     not all(isinstance(x, str) for x in raw["reference_answers"])):
                    raise ValueError(f"reference_answers必须是字符串数组: {location}")
                metadata = raw.get("metadata", {})
                if not isinstance(metadata, dict):
                    raise ValueError(f"metadata必须是对象: {location}")
                cases.append(EvalCase(safe_id(raw["id"]), raw["question"], str(path.parent),
                                      expected={k: raw[k] for k in ("reference_answers", "criteria", "reference_documents") if k in raw},
                                      metadata={**metadata, **location}))
        return select(cases, config)

    def fingerprint(self, case):
        return fingerprint({"id": case.case_id, "question": case.question})

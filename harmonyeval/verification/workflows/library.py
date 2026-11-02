"""Check migration APIs, compatibility and functional acceptance."""

import asyncio
import json
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path
from harmonyeval.config.loader import read_yaml
from harmonyeval.api.registry import verifiers
from harmonyeval.utils.paths import inside
from harmonyeval.utils.io import write_json
from harmonyeval.utils.numbers import number
from harmonyeval.verification.base import Workflow, result
from harmonyeval.verification.context import command_run, isolated_project, workflow_settings


@verifiers.register("LibraryTests")
class LibraryTests(Workflow):
    async def verify(self, case, execution, dependencies, context, config):
        settings = workflow_settings(case, config)
        if not settings.get("build_command") or not settings.get("test_command"):
            return result(config, "unavailable", error="用例需要 build_command 和 test_command；可在 grading/tests/verification.yaml 声明")
        project = await isolated_project(execution, context)
        tests = case.expected.get("tests")
        if tests:
            source = inside(case.root, tests, exists=True)
            if source.is_dir():
                shutil.copytree(source, project / settings.get("tests_destination", "evaluation-tests"), dirs_exist_ok=True)
        build = await command_run(settings["build_command"], project, context, "build", settings.get("timeout", 600))
        if build["exit_code"]:
            return result(config, "failed", metrics={"build_passed": False, "all_tests_passed": False,
                                                    "pass_rate": None}, evidence=[build])
        test = await command_run(settings["test_command"], project, context, "tests", settings.get("timeout", 600))
        metrics = {"build_passed": True, "all_tests_passed": test["exit_code"] == 0, "pass_rate": None}
        junit = settings.get("junit_path")
        if junit:
            suites = ET.parse(inside(project, junit, exists=True)).getroot()
            nodes = [suites] if suites.tag == "testsuite" else list(suites.iter("testsuite"))
            leaves = [n for n in nodes if not list(n.findall("testsuite"))]
            counts = {key: sum(int(n.get(key, 0)) for n in leaves) for key in ("tests", "failures", "errors", "skipped")}
            run = counts["tests"] - counts["skipped"]
            metrics.update({"tests_run": run, "passes": max(0, run - counts["failures"] - counts["errors"]),
                            "pass_rate": max(0, run - counts["failures"] - counts["errors"]) / run if run else None,
                            "all_tests_passed": run > 0 and counts["failures"] == counts["errors"] == 0 and test["exit_code"] == 0})
        elif settings.get("exit_code_is_test_result") is True:
            metrics["pass_rate"] = 1.0 if test["exit_code"] == 0 else 0.0
        return result(config, metrics=metrics, evidence=[build, test],
                      findings=[] if junit else ["未提供JUnit计数；通过率仅在显式声明 exit_code_is_test_result 时使用命令结果。"])


@verifiers.register("LibraryAPICount")
class LibraryAPICount(Workflow):
    python_dependencies = ("tree_sitter", "tree_sitter_dart", "tree_sitter_typescript",
                           "tree_sitter_javascript", "tree_sitter_java", "tree_sitter_kotlin")
    schema = {"type": "object", "properties": {
        **{side + "_paths": {"type": "array", "minItems": 1, "items": {"type": "string"}} for side in ("source", "target")},
        **{side + "_languages": {"type": "array", "minItems": 1, "items": {"enum": ["dart", "typescript", "javascript", "java", "kotlin"]}}
           for side in ("source", "target")}}}

    async def capture_input(self, case, config):
        from harmonyeval.integrations.code.api_inventory import inventory
        if not case.project:
            raise ValueError("LibraryAPICount需要包含源工程的用例")
        settings = workflow_settings(case, config)
        return await asyncio.to_thread(inventory, case.project, paths=settings.get("source_paths"), languages=settings.get("source_languages"))

    async def verify(self, case, execution, dependencies, context, config):
        from harmonyeval.integrations.code.api_inventory import inventory, CATEGORIES
        folder = Path(context["output"])
        baseline = folder / "input-evidence.json"
        if not baseline.is_file():
            return result(config, "unavailable", error="缺少Agent执行前的API快照，请重新执行生成；不能用执行后的源码伪造转换前基线")
        frozen = json.loads(baseline.read_text())
        if frozen["status"] != "completed":
            return result(config, "unavailable", error="转换前API统计不可用: " + frozen.get("error", ""), evidence=[str(baseline)])
        source = frozen["data"]
        if not source["total"]:
            return result(config, "unavailable", error="原库未识别到公开API，无法计算数量一致率", evidence=[str(baseline)])
        settings = workflow_settings(case, config)
        target = await asyncio.to_thread(inventory, execution.project, paths=settings.get("target_paths"), languages=settings.get("target_languages"))
        counts = {kind: {"source": source["counts"][kind], "target": target["counts"][kind],
                         "delta": target["counts"][kind] - source["counts"][kind]} for kind in CATEGORIES}
        numerator = sum(min(c["source"], c["target"]) for c in counts.values())
        denominator = sum(max(c["source"], c["target"]) for c in counts.values())
        metrics = {"count_match": all(c["delta"] == 0 for c in counts.values()),
                   "total_match": source["total"] == target["total"],
                   "source_total": source["total"], "target_total": target["total"],
                   "total_delta": target["total"] - source["total"],
                   "count_consistency": numerator / denominator, "counts": counts}
        finding = "仅检查公开声明的分类数量；数量一致不证明逐项API对应、鸿蒙平台实现、编译成功或功能正确。"
        document = {"metrics": metrics, "source": source, "target": target, "limitations": [finding]}
        write_json(folder / "api-count.json", document)
        labels = {"types": "公开类型", "callables": "方法／函数", "properties": "属性／常量"}
        lines = ["# API 数量检查", "", finding, "", "| 类别 | 转换前 | 转换后 | 差值 |", "|---|---:|---:|---:|"]
        lines.extend(f"| {labels[kind]} | {c['source']} | {c['target']} | {c['delta']:+d} |" for kind, c in counts.items())
        lines += ["", f"分类数量一致率：{metrics['count_consistency']:.2%}。", ""]
        for title, data in (("转换前公开声明", source), ("转换后公开声明", target)):
            lines += ["## " + title, "", "扫描语言：" + ", ".join(data["languages"]), ""]
            lines += [f"- `{entry['file']}:{entry['line']}` · {labels[entry['kind']]} · `{entry['name']}`" for entry in data["apis"]]
            lines += ["", *data["notes"], ""]
        (folder / "api-count.md").write_text("\n".join(lines), encoding="utf-8")
        return result(config, metrics=metrics, findings=[finding, *source["notes"], *target["notes"]],
                      evidence=[str(baseline), str(folder / "api-count.json"), str(folder / "api-count.md")])


@verifiers.register("LibraryAPICompatibility")
class LibraryAPICompatibility(Workflow):
    async def verify(self, case, execution, dependencies, context, config):
        mapping = case.expected.get("api_mapping")
        if not mapping:
            return result(config, "unavailable", error="用例缺少 expected.api_mapping")
        raw = read_yaml(inside(case.root, mapping, exists=True))
        entries = raw.get("apis", [])
        if not entries:
            return result(config, "unavailable", error="API映射缺少 apis 列表")
        files = [p for p in Path(execution.project).rglob("*") if p.is_file() and p.suffix in (".ets", ".ts", ".js", ".h", ".cpp", ".dart")]
        matched, total, evidence = 0, 0, []
        for entry in entries:
            weight = number(entry.get("weight", 1))
            if weight <= 0:
                raise ValueError("API权重必须大于0")
            total += weight
            symbols = entry.get("required_symbols") or [entry["target"]]
            selected = files if not entry.get("file") else [inside(execution.project, entry["file"], exists=True)]
            text = "\n".join(p.read_text(errors="replace") for p in selected)
            found = all(symbol in text for symbol in symbols)
            if found:
                matched += weight
            evidence.append({"source": entry.get("source"), "required_symbols": symbols, "present": found})
        return result(config, metrics={"coverage": matched / total}, evidence=evidence,
                      findings=["coverage衡量声明的目标符号覆盖；API行为等价由功能测试另行验证。"])

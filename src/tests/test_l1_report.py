"""L1 评分报告测试（移植自 autorun-0929 的 l1-report.test.mjs）。"""

import json
import re
import tempfile
import unittest
from pathlib import Path

from pyautorun.reporting.html import agent_display_name, agent_source_label
from pyautorun.reporting.l1_report import (collect_l1_report_targets, compute_l1_verdict,
                                           l1_column_label, write_l1_reports)


class ComputeL1VerdictTests(unittest.TestCase):
    def test_full_score_requires_build_passed_and_all_tests_passed(self):
        verdict = compute_l1_verdict(
            {"status": "passed"},
            [{"status": "passed", "testsRun": 3, "passes": 3, "failures": 0, "errors": 0},
             {"status": "passed", "testsRun": 2, "passes": 2, "failures": 0, "errors": 0}])
        self.assertTrue(verdict["buildComplete"])
        self.assertTrue(verdict["functionComplete"])
        self.assertEqual(verdict["score"], 100)
        self.assertEqual(verdict["totals"]["testsRun"], 5)

    def test_zero_score_for_build_failed_case_failed_or_no_tests(self):
        self.assertEqual(compute_l1_verdict(
            {"status": "blocked"},
            [{"status": "passed", "testsRun": 1, "passes": 1}])["score"], 0)
        self.assertEqual(compute_l1_verdict(
            {"status": "passed"},
            [{"status": "failed", "testsRun": 2, "passes": 1, "failures": 1}])["score"], 0)
        self.assertEqual(compute_l1_verdict({"status": "passed"}, [])["score"], 0)
        # 全通过但零执行用例：视为功能未完成
        self.assertEqual(compute_l1_verdict(
            {"status": "passed"},
            [{"status": "passed", "testsRun": 0, "passes": 0}])["score"], 0)
        # 缺少 ohosTest 数据整体按 0 分
        self.assertEqual(compute_l1_verdict()["score"], 0)


class ColumnLabelTests(unittest.TestCase):
    def test_column_label_follows_source_mode(self):
        self.assertEqual(l1_column_label({"mode": "harmonyBot", "agent": "harmonyos-multi-device"}),
                         "带skill")
        self.assertEqual(l1_column_label({"mode": "softwareEngineering", "agent": "build"}),
                         "不带skill")
        self.assertEqual(l1_column_label({"mode": "baseModel"}), "不带skill")

    def test_agent_display_name_appends_source_label(self):
        self.assertEqual(agent_display_name("harmonyos-multi-device", "harmonyBot"),
                         "harmonyos-multi-device/自研")
        self.assertEqual(agent_display_name("build", "softwareEngineering"), "build/软工")
        self.assertEqual(agent_display_name("build", ""), "build")
        self.assertEqual(agent_source_label("baseModel"), "裸模")
        self.assertEqual(agent_source_label("unknown-mode"), "")


def _write_target_fixture(root, identifier, mode, agent, case_reports):
    directory = Path(root) / identifier
    directory.mkdir(parents=True)
    case_names = list(case_reports)
    (directory / "summary.json").write_text(json.dumps({
        "batchId": "20260929100000", "agent": agent, "providerId": "zhipuai-coding-plan",
        "modelId": "glm-5.3", "opencodeSourceMode": mode, "status": "completed",
        "total": len(case_names),
        "results": [{"case": name, "status": "completed"} for name in case_names],
    }, ensure_ascii=False), encoding="utf-8")
    rendered = []
    for case_name, spec in case_reports.items():
        source_result_path = ""
        if spec.get("runnerResult") is not None:
            runner_dir = directory / "runner" / case_name
            runner_dir.mkdir(parents=True)
            source_result_path = str(runner_dir / "result.json")
            (runner_dir / "result.json").write_text(json.dumps(spec["runnerResult"]), encoding="utf-8")
        rendered.append({
            "case": case_name,
            "status": spec.get("ohosTestStatus") or "completed",
            "error": spec.get("error") or "",
            "sourceResultPath": source_result_path,
            "runnerOutputAvailable": spec.get("runnerResult") is not None,
            "run": None if spec.get("run", False) is None else {
                "status": spec.get("ohosTestStatus") or "completed",
                "build": spec.get("build") or {"status": "blocked"},
                "devices": spec.get("devices") or [],
                "diagnostics": [],
            },
        })
    (directory / "report.json").write_text(json.dumps({
        "agent": {"type": agent}, "ohosTest": {"caseResults": rendered},
    }, ensure_ascii=False), encoding="utf-8")
    skills = (["harmonyos-ui-multi", "harmonyos-flutter-multi"] if mode == "harmonyBot"
              else ["hmos-multidevice-fold-state"])
    (directory / "environment.json").write_text(json.dumps({
        "agent": agent,
        "generationModel": {"providerId": "zhipuai-coding-plan", "modelId": "glm-5.3"},
        "skills": {"loaded": skills},
    }, ensure_ascii=False), encoding="utf-8")
    return {"id": identifier, "label": identifier, "mode": mode, "agent": agent,
            "targetRoot": str(directory)}


class WriteL1ReportsTests(unittest.TestCase):
    def test_writes_single_page_report_index_and_scoring_data(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            pass_devices = [{"status": "passed", "testsRun": 2, "passes": 2, "failures": 0, "errors": 0}]
            harmonybot = _write_target_fixture(root, "harmonybot", "harmonyBot", "harmonyos-multi-device", {
                "CaseBookRead": {
                    "build": {"status": "passed", "durationSec": 60},
                    "devices": pass_devices,
                    "runnerResult": {"caseId": "bookread-template-derive-base"},
                },
            })
            software = _write_target_fixture(root, "software-engineering", "softwareEngineering", "build", {
                "CaseBookRead": {
                    "build": {"status": "passed"},
                    "devices": [{"status": "failed", "testsRun": 2, "passes": 1, "failures": 1, "errors": 0}],
                    "runnerResult": {"caseId": "bookread-template-derive-base"},
                    "error": "1 个用例失败",
                },
            })
            result = write_l1_reports(root, "20260929100000",
                                      {"providerId": "zhipuai-coding-plan", "modelId": "glm-5.3"},
                                      [harmonybot, software])
            self.assertEqual(result["data"]["schemaVersion"], "autorun-l1-report-v1")
            case_data = result["data"]["cases"][0]
            self.assertEqual(case_data["caseName"], "CaseBookRead")
            self.assertEqual(case_data["caseId"], "bookread-template-derive-base")
            self.assertEqual(case_data["anchorId"], "CaseBookRead")
            self.assertEqual(case_data["dimensions"]["harmonybot"]["score"], 100)
            self.assertEqual(case_data["dimensions"]["software-engineering"]["score"], 0)

            # 单页报告：只生成 index.html，不再有分散的用例页面
            page_html = Path(result["indexPagePath"]).read_text(encoding="utf-8")
            for marker in ("用例信息", "bookread-template-derive-base", "用例ID", "用例名称",
                           "所属SKILL", "评测模型", "AGENT框架", "二级维度",
                           "<th>不带skill</th>", "<th>带skill</th>",
                           '<h3 class="l1-h2-bar">用例信息</h3>',
                           '<h3 class="l1-h2-bar">结果维度 - L1 功能</h3>',
                           "构建完成", "功能完成",
                           '<span class="l1-verdict l1-verdict-pass">通过</span>',
                           '<span class="l1-verdict l1-verdict-fail">不通过</span>',
                           ".l1-verdict { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }",
                           '<table class="l1-table">',
                           ".l1-table tbody tr:nth-child(even) td { background: #f8fafc; }",
                           "<th>结果对比</th>",
                           '<span class="l1-delta l1-delta-good">改善</span>',
                           ".l1-delta-good { color: #15803d; }",
                           ".l1-delta-bad { color: #b91c1c; }",
                           "100 分", "0 分",
                           "zhipuai-coding-plan/glm-5.3", "harmonyos-ui-multi",
                           "hmos-multidevice-fold-state", "l1-sidebar", "导航", "汇聚报告",
                           "S-001 静态质量", 'href="#l1-aggregate"', 'href="#s-001-static"',
                           'href="#case-CaseBookRead"', 'id="l1-aggregate"', 'id="s-001-static"',
                           'id="case-CaseBookRead"', 'class="l1-section l1-panel" id="s-001-static"',
                           'class="l1-section l1-panel" id="case-CaseBookRead"', "data-l1-section",
                           "IntersectionObserver", "scroll-behavior: smooth", "L1 评分报告"):
                self.assertIn(marker, page_html)
            # 「L1 评分」行与维度描述已按口径移除
            self.assertNotIn(">L1 评分</td>", page_html)
            self.assertNotIn("l1-detail", page_html)
            self.assertNotIn("耗时 ", page_html)
            self.assertNotIn("设备 1 台", page_html)
            # 结果对比：构建两列同过 → -；功能带skill 过而不带skill 未过 → 改善
            self.assertEqual(page_html.count("<td>-</td>"), 1)
            self.assertNotIn("l1-delta-bad", page_html.replace(".l1-delta-bad { color: #b91c1c; }", ""))
            # 列顺序固定：不带skill 在前、带skill 在后（不受传入 targets 顺序影响）
            self.assertLess(page_html.index("<th>不带skill</th>"),
                            page_html.index("<th>带skill</th>"),
                            "不带skill 列应排在带skill 列之前")
            # 汇聚报告章节只保留统计卡片，不含用例得分表（表格在各用例章节内）
            aggregate = re.search(r'<section[^>]*id="l1-aggregate".*?</section>', page_html, re.S)
            self.assertTrue(aggregate, "汇聚报告章节应存在")
            self.assertIn('class="l1-section l1-panel"', aggregate.group(0))
            self.assertIn('<h2 class="l1-h2-bar">总览</h2>', aggregate.group(0))
            self.assertIn("用例总数", aggregate.group(0))
            self.assertNotIn("<table", aggregate.group(0), "汇聚报告章节不应包含表格")
            self.assertTrue(Path(result["dataPath"]).is_file())
            leftovers = [item.name for item in Path(result["indexPagePath"]).parent.iterdir()
                         if item.suffix == ".html"]
            self.assertEqual(leftovers, ["index.html"])

    def test_marks_missing_case_dimensions_as_not_run_with_zero_score(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            harmonybot = _write_target_fixture(root, "harmonybot", "harmonyBot", "harmonyos-multi-device", {
                "CaseOnlyA": {
                    "build": {"status": "passed"},
                    "devices": [{"status": "passed", "testsRun": 1, "passes": 1, "failures": 0, "errors": 0}],
                },
            })
            software = _write_target_fixture(root, "software-engineering", "softwareEngineering", "build", {
                "CaseOnlyB": {"build": {"status": "blocked"}, "devices": []},
            })
            result = write_l1_reports(root, "20260929110000",
                                      {"providerId": "zhipuai-coding-plan", "modelId": "glm-5.3"},
                                      [harmonybot, software])
            by_name = {item["caseName"]: item for item in result["data"]["cases"]}
            self.assertEqual(by_name["CaseOnlyA"]["dimensions"]["harmonybot"]["score"], 100)
            self.assertFalse(by_name["CaseOnlyA"]["dimensions"]["software-engineering"]["present"])
            self.assertEqual(by_name["CaseOnlyA"]["dimensions"]["software-engineering"]["score"], 0)
            self.assertEqual(by_name["CaseOnlyB"]["dimensions"]["software-engineering"]["score"], 0)
            page_html = Path(result["indexPagePath"]).read_text(encoding="utf-8")
            for marker in ('id="case-CaseOnlyA"', 'id="case-CaseOnlyB"', "未执行"):
                self.assertIn(marker, page_html)


class CollectL1ReportTargetsTests(unittest.TestCase):
    def test_picks_latest_batch_and_supports_direct_target_dir(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old_batch = root / "20260101000000"
            new_batch = root / "20260929100000"
            for batch in (old_batch, new_batch):
                target = batch / "harmonybot"
                target.mkdir(parents=True)
                (target / "summary.json").write_text("{}", encoding="utf-8")
            import os
            os.utime(old_batch, (1, 1))
            run_root, targets = collect_l1_report_targets("", root)
            self.assertEqual(run_root, str(new_batch))
            self.assertEqual([item["id"] for item in targets], ["harmonybot"])
            # 直接指向单个 Agent 目标目录（含 summary.json）
            run_root, targets = collect_l1_report_targets(str(new_batch / "harmonybot"), root)
            self.assertEqual(run_root, str(new_batch))
            self.assertEqual(targets[0]["targetRoot"], str(new_batch / "harmonybot"))
            with self.assertRaisesRegex(ValueError, "目录不存在"):
                collect_l1_report_targets("missing-batch", root)


if __name__ == "__main__":
    unittest.main()

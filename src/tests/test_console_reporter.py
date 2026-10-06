"""Console dashboard output for interactive and redirected autorun runs."""

import io
import unittest

from pyautorun.orchestration.console_reporter import ConsoleReporter, display_width


class FakeTerminal(io.StringIO):
    columns = 120

    def isatty(self):
        return True


class ConsoleReporterTests(unittest.TestCase):
    def test_redirected_output_prints_one_final_table(self):
        output = io.StringIO()
        reporter = ConsoleReporter([{"name": "沉浸式用例"}, {"name": "跳过用例", "skipReason": "无需执行"}], output)
        reporter.start()
        reporter.case_started("沉浸式用例")
        reporter.case_progress("沉浸式用例", "正在生成代码")
        self.assertEqual(output.getvalue(), "")
        reporter.case_finished({"case": "沉浸式用例", "status": "failed", "agentStatus": "failed",
                                "error": "编译失败", "tokenUsage": {"input": 1200, "output": 300, "total": 1500}})
        reporter.finish()
        reporter.finish()
        value = output.getvalue()
        self.assertEqual(value.count("生成状态"), 1)
        self.assertIn("测试状态", value)
        self.assertIn("沉浸式用例", value)
        self.assertIn("编译失败", value)
        self.assertIn("已跳过", value)

    def test_interactive_table_updates_without_overwide_lines(self):
        output = FakeTerminal()
        reporter = ConsoleReporter([{"name": "ImmersiveHideAvoidArea"}], output)
        reporter.start()
        reporter.case_started("ImmersiveHideAvoidArea")
        reporter.case_progress("ImmersiveHideAvoidArea", "正在处理中文内容")
        reporter.case_usage("ImmersiveHideAvoidArea", {"tokenUsage": {"input": 1300, "output": 500, "total": 1800}})
        reporter.case_test_queued("ImmersiveHideAvoidArea", "ohosTest")
        reporter.case_test_running("ImmersiveHideAvoidArea", "ohosTest")
        reporter.case_test_finished("ImmersiveHideAvoidArea", "ohosTest", {"status": "completed"})
        reporter.case_finished({"case": "ImmersiveHideAvoidArea", "status": "completed",
                                "agentStatus": "completed", "ohosTest": {"status": "completed"}})
        reporter.finish()
        value = output.getvalue()
        self.assertIn("\x1b[3A\r\x1b[J", value)
        self.assertIn("Token(入/出/总)", value)
        self.assertIn("运行中", value)
        self.assertIn("已完成", value)
        self.assertTrue(all(display_width(line) < output.columns for line in value.splitlines()
                            if "\x1b" not in line))


if __name__ == "__main__":
    unittest.main()

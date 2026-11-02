"""Compact, width-aware console dashboard for a Python autorun batch."""

from datetime import datetime
import re
import shutil
import sys
import time
import unicodedata


LABELS = {
    "queued": "排队中", "preparing": "准备中", "running": "运行中",
    "passed": "已通过", "skipped": "已跳过", "completed": "已完成",
    "failed": "失败", "timed_out": "超时", "rate_limited": "限额",
    "interrupted": "已中断", "cancelled": "已取消", "not_started": "--",
}


def display_width(value):
    return sum(2 if unicodedata.east_asian_width(char) in ("F", "W") or
               0x1F300 <= ord(char) <= 0x1FAFF else 1 for char in str(value))


def cell(value, width):
    value = re.sub(r"\s+", " ", str(value or "")).strip()
    if display_width(value) > width:
        result = ""
        for char in value:
            if display_width(result + char + "…") > width:
                break
            result += char
        value = result + "…"
    return value + " " * max(0, width - display_width(value))


def status(value):
    return LABELS.get(value, value or "--")


def tokens(value):
    try:
        number = max(0, float(value or 0))
    except (ValueError, TypeError):
        number = 0
    if number < 1000:
        return f"{number / 1000:.1f}k"
    if number < 1_000_000:
        return f"{number / 1000:.{1 if number < 10_000 else 0}f}k"
    return f"{number / 1_000_000:.{1 if number < 10_000_000 else 0}f}m"


def compile_usage(value):
    value = value or {}
    attempts = int(value.get("attempts") or 0)
    if not attempts:
        return "0"
    detail = "/".join(f"{value[key]}{symbol}" for key, symbol in
                      (("succeeded", "✓"), ("failed", "✗"), ("interrupted", "中"), ("running", "运"))
                      if value.get(key))
    return f"{attempts}({detail})" if detail else str(attempts)


def elapsed(item):
    start = item.get("startedAt")
    if start is None:
        return "--:--"
    seconds = max(0, round((item.get("finishedAt") or time.monotonic()) - start))
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:02}:{minutes:02}:{seconds:02}" if hours else f"{minutes:02}:{seconds:02}"


def columns(width):
    usable = max(1, width - 1)
    if width < 16:
        return [("用例状态", usable, lambda row: f"{row['name']}: {status(row['agentStatus'])}")]
    if width >= 140:
        case_width = 40
    elif width >= 100:
        case_width = 28
    elif width >= 90:
        case_width = max(16, min(24, int(usable * .28)))
    elif width >= 80:
        case_width = 20
    elif width >= 70:
        case_width = 17
    elif width >= 60:
        case_width = 16
    elif width >= 40:
        case_width = max(10, int(usable * .28))
    elif width >= 32:
        case_width = 8
    else:
        case_width = max(4, int(usable * .34))
    status_width = 10 if width >= 70 else 8 if width >= 32 else max(4, int(usable * .28))
    result = [("用例", case_width, lambda row: row["name"]),
              ("生成状态", status_width, lambda row: status(row["agentStatus"]))]
    if width >= 32:
        result.append(("测试状态", status_width, lambda row: status(row["ohosTestStatus"])))
    if width >= 70:
        result.extend([("云测试", 10, lambda row: status(row["cloudTestStatus"])),
                       ("耗时", 9, elapsed)])
    if width >= 160:
        result.extend((title, 11, lambda row, key=key: tokens(row["tokenUsage"].get(key)))
                      for title, key in (("输入Token", "input"), ("输出Token", "output"), ("总Token", "total")))
        result.append(("编译", 18, lambda row: compile_usage(row["compileUsage"])))
    elif width >= 120:
        result.append(("Token(入/出/总)", 22, lambda row: "/".join(tokens(row["tokenUsage"].get(key))
                                                           for key in ("input", "output", "total"))))
    elif width >= 100:
        result.append(("总Token", 10, lambda row: tokens(row["tokenUsage"].get("total"))))
    activity_width = max(1, usable - sum(col[1] for col in result) - 2 * len(result))
    result.append(("当前操作", activity_width, lambda row: row["activity"]))
    return result


class ConsoleReporter:
    def __init__(self, cases, stream=None):
        self.stream = stream if stream is not None else sys.stdout
        self.width = self._width()
        self.dynamic = bool(self.stream.isatty() and self.width >= 90)
        self.rows = {item["name"]: {
            "name": item["name"], "agentStatus": "skipped" if item.get("skipReason") else "queued",
            "ohosTestStatus": "not_started", "cloudTestStatus": "not_started",
            "activity": item.get("skipReason") or "等待 Worker", "tokenUsage": {}, "compileUsage": {},
            "startedAt": None, "finishedAt": None,
        } for item in cases}
        self.rendered_lines = 0
        self.last_output = ""
        self.finished = False

    def _width(self):
        if self.stream is sys.stdout:
            return shutil.get_terminal_size(fallback=(80, 24)).columns
        return int(getattr(self.stream, "columns", 80) or 80)

    def _lines(self, width):
        cols = columns(width)
        return ["  ".join(cell(title, size) for title, size, _ in cols),
                "  ".join("-" * size for _, size, _ in cols),
                *("  ".join(cell(value(row), size) for _, size, value in cols)
                  for row in self.rows.values())]

    def render(self, force=False):
        if self.finished or not self.dynamic:
            return
        width = self._width()
        if width < 90:
            self._clear()
            self.dynamic = False
            return
        output = "\n".join(self._lines(width))
        if not force and output == self.last_output:
            return
        self._clear()
        self.stream.write(output + "\n")
        self.stream.flush()
        self.rendered_lines = len(self.rows) + 2
        self.last_output = output

    def _clear(self):
        if self.rendered_lines:
            self.stream.write(f"\x1b[{self.rendered_lines}A\r\x1b[J")
        self.rendered_lines = 0
        self.last_output = ""

    def start(self):
        self.render(True)

    def case_started(self, name):
        row = self.rows[name]
        row.update(agentStatus="preparing", activity="复制并初始化工程", startedAt=time.monotonic())
        self.render()

    def case_progress(self, name, message):
        row = self.rows.get(name)
        if row and row["agentStatus"] not in ("completed", "timed_out", "failed", "rate_limited"):
            row.update(agentStatus="running", activity=str(message))
            self.render()

    def case_agent_finished(self, result):
        row = self.rows[result["case"]]
        row.update(agentStatus=result.get("agentStatus") or result.get("status") or "failed",
                   tokenUsage=result.get("tokenUsage") or row["tokenUsage"],
                   compileUsage=result.get("agentCompile") or row["compileUsage"])
        self.render()

    def case_usage(self, name, state):
        row = self.rows.get(name)
        if row:
            row["tokenUsage"] = state.get("tokenUsage") or row["tokenUsage"]
            row["compileUsage"] = state.get("agentCompile") or row["compileUsage"]
            self.render()

    def case_test_queued(self, name, kind):
        row = self.rows[name]
        row[kind + "Status"] = "queued"
        if kind == "ohosTest":
            row["activity"] = "Agent 已完成，等待串行 ohosTest"
        self.render()

    def case_test_running(self, name, kind):
        row = self.rows[name]
        row[kind + "Status"] = "running"
        if kind == "ohosTest":
            row["activity"] = "ohosTest 执行中：拉起模拟器并运行用例"
        self.render()

    def case_test_finished(self, name, kind, result):
        row = self.rows[name]
        row[kind + "Status"] = (result or {}).get("status") or "failed"
        if kind == "ohosTest":
            row["activity"] = "ohosTest 已完成，等待云测试" if row["cloudTestStatus"] in ("queued", "running") else (
                "ohosTest 已完成" if row["ohosTestStatus"] == "completed" else
                f"ohosTest {status(row['ohosTestStatus'])}：{(result or {}).get('error') or ''}")
        self.render()

    def case_finished(self, result):
        row = self.rows[result["case"]]
        self.case_agent_finished(result)
        row.update(ohosTestStatus=(result.get("ohosTest") or {}).get("status") or row["ohosTestStatus"],
                   cloudTestStatus=(result.get("cloudTest") or {}).get("status") or row["cloudTestStatus"],
                   activity="已完成" if result.get("status") == "completed" else
                   result.get("error") or result.get("status") or "失败",
                   finishedAt=time.monotonic())
        self.render(True)

    def case_cancelled(self, name, reason):
        self.rows[name].update(agentStatus="cancelled", activity=reason, finishedAt=time.monotonic())
        self.render(True)

    def finish(self, error=None):
        if self.finished:
            return
        if error:
            for row in self.rows.values():
                if row["finishedAt"] is None and row["agentStatus"] != "skipped":
                    row.update(agentStatus="failed", activity=str(error), finishedAt=time.monotonic())
        if self.dynamic:
            self.render(True)
        else:
            self.stream.write("\n".join(self._lines(self._width())) + "\n")
            self.stream.flush()
        self.finished = True

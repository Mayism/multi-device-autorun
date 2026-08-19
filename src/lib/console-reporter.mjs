import process from "node:process";
import path from "node:path";

const MODES = new Set(["dashboard", "summary", "verbose"]);
const STATUS_LABELS = {
  queued: "排队中",
  preparing: "准备中",
  running: "运行中",
  ohostest_queued: "待测试",
  ohostest_running: "测试中",
  passed: "已通过",
  skipped: "已跳过",
  passed_with_skips: "通过(有跳过)",
  completed: "已完成",
  failed: "失败",
  timed_out: "超时",
  interrupted: "已中断",
  cancelled: "已取消",
};

function displayWidth(value) {
  let width = 0;
  for (const char of String(value || "")) {
    const code = char.codePointAt(0);
    const wide = code >= 0x1100 && (
      code <= 0x115f || code === 0x2329 || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe10 && code <= 0xfe19)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1faff)
    );
    width += wide ? 2 : 1;
  }
  return width;
}

function truncateCell(value, targetWidth) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (displayWidth(text) <= targetWidth) return text;
  let result = "";
  for (const char of text) {
    if (displayWidth(`${result}${char}…`) > targetWidth) break;
    result += char;
  }
  return `${result}…`;
}

function cell(value, targetWidth) {
  const text = truncateCell(value, targetWidth);
  return `${text}${" ".repeat(Math.max(0, targetWidth - displayWidth(text)))}`;
}

function renderedRows(lines, terminalColumns) {
  const columns = Math.max(1, Number(terminalColumns) || 1);
  return lines.reduce((total, line) => (
    total + Math.max(1, Math.ceil(displayWidth(line) / columns))
  ), 0);
}

function supportsDashboard(stream) {
  return Boolean(
    stream?.isTTY
    && typeof stream.moveCursor === "function"
    && typeof stream.cursorTo === "function"
    && typeof stream.clearScreenDown === "function"
  );
}

function elapsed(startedAt, finishedAt = Date.now()) {
  if (!startedAt) return "--:--";
  const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function formatTokenCount(value) {
  const count = Math.max(0, Number(value) || 0);
  if (count < 1000) return `${(Math.round(count / 100) / 10).toFixed(1)}k`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}m`;
}

function tokenText(usage = {}) {
  return `${formatTokenCount(usage.input)}/${formatTokenCount(usage.output)}/${formatTokenCount(usage.total)}`;
}

function compileText(usage = {}) {
  const values = ["succeeded", "failed", "interrupted", "running"].map((field) => Math.max(0, Number(usage[field]) || 0));
  const attempts = Math.max(0, Number(usage.attempts) || 0);
  if (!attempts) return "0";
  const labels = ["\u2713", "\u2717", "\u4e2d", "\u8fd0"];
  const detail = values.map((value, index) => value ? `${value}${labels[index]}` : "").filter(Boolean).join("/");
  return detail ? `${attempts}(${detail})` : String(attempts);
}

function statusText(status) {
  if (status === "not_started") return "--";
  return STATUS_LABELS[status] || status || "--";
}

export class ConsoleReporter {
  constructor({ mode = "dashboard", batchId, cases, concurrency, batchRoot }) {
    const requested = MODES.has(mode) ? mode : "dashboard";
    this.mode = requested === "dashboard" && !supportsDashboard(process.stdout) ? "summary" : requested;
    this.requestedMode = requested;
    this.batchId = batchId;
    this.batchRoot = batchRoot;
    this.concurrency = concurrency;
    this.startedAt = Date.now();
    this.timer = null;
    this.lastRendered = "";
    this.lastRenderedLines = [];
    this.lastTerminalColumns = 0;
    this.renderedLineCount = 0;
    this.dashboardPaused = false;
    this.cases = new Map(cases.map((item) => [item.name, {
      name: item.name,
      status: item.skipReason ? "skipped" : "queued",
      agentStatus: item.skipReason ? "skipped" : "queued",
      ohosTestStatus: "not_started",
      cloudTestStatus: "not_started",
      activity: item.skipReason || "等待 Worker",
      startedAt: null,
      finishedAt: item.skipReason ? Date.now() : null,
      worker: null,
      phase: item.skipReason ? "skipped" : "queued",
      transcriptPath: "",
      tokenUsage: {},
      compileUsage: {},
    }]));
  }

  write(line = "") {
    process.stdout.write(`${line}\n`);
  }

  start() {
    if (this.mode === "dashboard") {
      this.render(true);
      this.timer = setInterval(() => this.render(), 1000);
      this.timer.unref?.();
      return;
    }
    this.write(`[batch:${this.batchId}] 启动 ${this.concurrency} 个 Worker，控制台模式=${this.mode}`);
    if (this.requestedMode === "dashboard" && this.mode !== "dashboard") {
      this.write("[console] 当前终端不支持可靠的光标重绘，dashboard 已自动切换为 summary");
    }
  }

  caseStarted(caseName, worker) {
    const item = this.cases.get(caseName);
    if (!item) return;
    item.agentStatus = "preparing";
    item.ohosTestStatus = "not_started";
    item.cloudTestStatus = "not_started";
    Object.assign(item, { status: "preparing", phase: "agent", activity: "复制并初始化工程", startedAt: Date.now(), worker });
    if (this.mode !== "dashboard") this.write(`[case:${caseName}] 开始执行（Worker ${worker}）`);
  }

  caseProgress(caseName, activity) {
    const item = this.cases.get(caseName);
    if (!item) return;
    item.agentStatus = "running";
    item.status = "running";
    item.phase = "agent";
    item.activity = String(activity || "Agent 运行中");
    if (this.mode === "verbose") this.write(`[case:${caseName}] ${item.activity}`);
  }

  caseTokenUsage(caseName, usage) {
    const item = this.cases.get(caseName);
    if (!item || !usage) return;
    item.tokenUsage = { ...usage };
  }

  caseCompileUsage(caseName, usage) {
    const item = this.cases.get(caseName);
    if (!item || !usage) return;
    item.compileUsage = { ...usage };
  }

  caseOhosTestQueued(caseName, { agentTimedOut = false } = {}) {
    const item = this.cases.get(caseName);
    if (!item) return;
    Object.assign(item, {
      status: "ohostest_queued",
      agentStatus: agentTimedOut ? "timed_out" : "completed",
      ohosTestStatus: "queued",
      phase: "ohostest_queued",
      // Agent 超时上报会预置 finishedAt，后置验证仍在进行，恢复计时
      finishedAt: null,
      activity: agentTimedOut
        ? "Agent 超时，仍等待串行 ohosTest"
        : "Agent 已完成，等待串行 ohosTest",
    });
    if (this.mode === "verbose") this.write(`[case:${caseName}] ${item.activity}`);
    this.render(true);
  }

  caseOhosTestStarted(caseName) {
    const item = this.cases.get(caseName);
    if (!item) return;
    Object.assign(item, {
      status: "ohostest_running",
      ohosTestStatus: "running",
      phase: "ohostest",
      activity: "ohosTest 执行中：拉起模拟器并运行用例",
    });
    if (this.mode !== "dashboard") this.write(`[case:${caseName}] ${item.activity}`);
    this.render(true);
  }

  caseCloudTestQueued(caseName) {
    const item = this.cases.get(caseName);
    if (!item) return;
    item.cloudTestStatus = "queued";
    item.finishedAt = null;
  }

  caseCloudTestProgress(caseName, activity, status = "running") {
    const item = this.cases.get(caseName);
    if (!item) return;
    // 只更新云测试列，不占用“当前操作”列（那里留给 ohosTest 等本地阶段）
    item.cloudTestStatus = status;
    if (this.mode === "verbose") this.write(`[case:${caseName}] ${String(activity || "云测试执行中")}`);
  }

  caseFinished(result) {
    const item = this.cases.get(result.case);
    if (!item) return;
    const transcriptPath = result.logs?.transcriptPath || "";
    const testedAfterAgentTimeout = result.status === "completed" && result.agentStatus === "timed_out";
    Object.assign(item, {
      status: result.status,
      agentStatus: result.agentStatus || item.agentStatus,
      ohosTestStatus: result.ohosTest?.status || item.ohosTestStatus,
      cloudTestStatus: result.cloudTest?.status || item.cloudTestStatus,
      phase: "finished",
      activity: result.status === "completed"
        ? testedAfterAgentTimeout ? "测试通过（Agent 曾超时）" : "已完成"
        : result.error || result.status,
      finishedAt: Date.now(),
      transcriptPath,
      tokenUsage: { ...(result.tokenUsage || item.tokenUsage) },
      compileUsage: { ...(result.agentCompile || item.compileUsage) },
    });
    if (this.mode !== "dashboard") {
      const label = result.status === "completed"
        ? testedAfterAgentTimeout ? "完成（Agent 曾超时，ohosTest 通过）" : "完成"
        : `${result.status}: ${result.error || ""}`;
      this.write(`[case:${result.case}] ${label}，耗时 ${result.elapsedSec}s`);
      if (transcriptPath) this.write(`[case:${result.case}] Agent 完整输出：${transcriptPath}`);
    }
    this.render(true);
  }

  caseCancelled(caseName, reason) {
    const item = this.cases.get(caseName);
    if (!item) return;
    item.agentStatus = "cancelled";
    Object.assign(item, { status: "cancelled", activity: reason, finishedAt: Date.now() });
    this.render(true);
  }

  clearDashboard() {
    if (this.mode !== "dashboard") return;
    if (this.renderedLineCount) {
      // 使用 Node 的 TTY 光标 API，让 Windows Console、Windows Terminal 和
      // VS Code Terminal 分别走其支持的控制方式，避免原始 VT 序列被当成普通输出。
      process.stdout.moveCursor(0, -this.renderedLineCount);
      process.stdout.cursorTo(0);
      process.stdout.clearScreenDown();
    }
    this.renderedLineCount = 0;
    this.lastRendered = "";
    this.lastRenderedLines = [];
    this.lastTerminalColumns = 0;
  }

  pauseDashboard() {
    if (this.mode !== "dashboard" || this.dashboardPaused) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clearDashboard();
    this.dashboardPaused = true;
  }

  render(force = false) {
    if (this.mode !== "dashboard" || this.dashboardPaused) return;
    const terminalColumns = Math.max(1, Number(process.stdout.columns) || 120);
    // 预留最后一列，避免 Windows 终端写满整行后触发自动换行。
    const terminalWidth = Math.max(40, terminalColumns - 1);
    const caseWidth = terminalColumns >= 140
      ? 40
      : terminalColumns >= 100
        ? 28
        : Math.max(16, Math.min(24, Math.floor(terminalWidth * 0.28)));
    const agentStatusWidth = terminalColumns >= 70 ? 10 : 8;
    const ohosTestStatusWidth = terminalColumns >= 70 ? 10 : 8;
    const cloudTestStatusWidth = terminalColumns >= 70 ? 10 : 8;
    const elapsedWidth = terminalColumns >= 70 ? 9 : 7;
    const tokenColumns = terminalColumns >= 160
      ? [
        { title: "输入Token", width: 11, value: (item) => formatTokenCount(item.tokenUsage.input) },
        { title: "输出Token", width: 11, value: (item) => formatTokenCount(item.tokenUsage.output) },
        { title: "总Token", width: 11, value: (item) => formatTokenCount(item.tokenUsage.total) },
      ]
      : terminalColumns >= 120
        ? [{ title: "Token(入/出/总)", width: 22, value: (item) => tokenText(item.tokenUsage) }]
        : terminalColumns >= 100
          ? [{ title: "总Token", width: 10, value: (item) => formatTokenCount(item.tokenUsage.total) }]
          : [];
    const compileColumns = terminalColumns >= 160
      ? [{ title: "\u7f16\u8bd1", width: 18, value: (item) => compileText(item.compileUsage) }]
      : [];
    const fixedWidth = caseWidth + agentStatusWidth + ohosTestStatusWidth + cloudTestStatusWidth + elapsedWidth
      + tokenColumns.reduce((sum, column) => sum + column.width, 0)
      + compileColumns.reduce((sum, column) => sum + column.width, 0);
    // 固定列为：用例、生成状态、测试状态、云测试、耗时、当前操作，
    // 因此基础分隔符有 5 个；每增加一个可选列再增加一个分隔符。
    const separatorWidth = 2 * (5 + tokenColumns.length + compileColumns.length);
    const activityWidth = Math.max(10, terminalWidth - fixedWidth - separatorWidth);
    const columns = [
      { title: "用例", width: caseWidth, value: (item) => item.name },
      { title: "生成状态", width: agentStatusWidth, value: (item) => statusText(item.agentStatus) },
      { title: "测试状态", width: ohosTestStatusWidth, value: (item) => statusText(item.ohosTestStatus) },
      { title: "云测试", width: cloudTestStatusWidth, value: (item) => statusText(item.cloudTestStatus) },
      { title: "耗时", width: elapsedWidth, value: (item) => elapsed(item.startedAt, item.finishedAt || Date.now()) },
      ...tokenColumns,
      ...compileColumns,
      { title: "当前操作", width: activityWidth, value: (item) => item.activity },
    ];
    const values = [...this.cases.values()];
    const lines = [
      columns.map((column) => cell(column.title, column.width)).join("  "),
      columns.map((column) => "-".repeat(column.width)).join("  "),
    ];
    for (const item of values) {
      lines.push(columns.map((column) => cell(column.value(item), column.width)).join("  "));
    }
    const output = lines.join("\n");
    if (!force && output === this.lastRendered) return;

    const changedLineIndexes = [];
    if (lines.length === this.lastRenderedLines.length) {
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index] !== this.lastRenderedLines[index]) changedLineIndexes.push(index);
      }
    }
    if (!changedLineIndexes.length && output === this.lastRendered) return;

    // 表格宽度足够时每个逻辑行都只占一个终端行，可以只改写发生变化的
    // 用例行，避免每秒清除并重画表头和整张表格。窄终端发生自动换行、
    // 终端尺寸变化或表格行数变化时，仍回退到完整重绘以保证光标位置可靠。
    const canUpdateChangedLines = this.renderedLineCount > 0
      && terminalColumns === this.lastTerminalColumns
      && lines.length === this.lastRenderedLines.length
      && lines.every((line) => renderedRows([line], terminalColumns) === 1)
      && this.lastRenderedLines.every((line) => renderedRows([line], terminalColumns) === 1);

    if (canUpdateChangedLines) {
      let cursorLine = lines.length;
      for (const lineIndex of changedLineIndexes) {
        process.stdout.moveCursor(0, lineIndex - cursorLine);
        process.stdout.cursorTo(0);
        if (typeof process.stdout.clearLine === "function") {
          process.stdout.clearLine(0);
        } else {
          process.stdout.write(" ".repeat(Math.max(1, terminalWidth)));
          process.stdout.cursorTo(0);
        }
        process.stdout.write(lines[lineIndex]);
        cursorLine = lineIndex;
      }
      process.stdout.moveCursor(0, lines.length - cursorLine);
      process.stdout.cursorTo(0);
    } else {
      this.clearDashboard();
      // Keep the cursor on the line immediately after the dashboard. The next
      // refresh moves up exactly renderedLineCount lines; without this trailing
      // newline it moves one line above the dashboard and erases earlier logs.
      process.stdout.write(`${output}\n`);
      this.renderedLineCount = renderedRows(lines, terminalColumns);
    }

    this.lastRendered = output;
    this.lastRenderedLines = lines;
    this.lastTerminalColumns = terminalColumns;
  }

  finish(summary) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.mode === "dashboard") {
      this.dashboardPaused = false;
      this.lastRendered = "";
      // 最后一次刷新后将表格留在终端中；后续摘要从下一行开始，不再回退清屏。
      this.render(true);
      this.renderedLineCount = 0;
      this.lastRendered = "";
    }
    this.write(`[batch:${this.batchId}] 结束：成功 ${summary.completed}/${summary.total}，失败 ${summary.failed}`);
    const reports = summary.reports || {};
    if (reports.htmlOverviewPath) {
      this.write(`[batch:${this.batchId}] HTML 报告：${reports.htmlOverviewPath}`);
    } else {
      this.write(`[batch:${this.batchId}] 报告：生成失败${summary.reportError ? `（${summary.reportError}）` : ""}`);
    }
    const detailPath = reports.jsonPath || path.join(this.batchRoot, "summary.json");
    this.write(`[batch:${this.batchId}] 详细结果：${detailPath}`);
  }
}

import process from "node:process";
const MIN_DYNAMIC_COLUMNS = 90;
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
  rate_limited: "限额",
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

function measuredStreamColumns(stream) {
  const columns = Number(stream?.columns);
  return Number.isFinite(columns) && columns > 1 ? Math.floor(columns) : 0;
}

function streamColumns(stream) {
  // 某些 MSYS/mintty 组合可能把 stdout 标为 TTY，却不给出可靠列数。
  // 这种场景按保守的 80 列生成最终静态表，不启用动态光标操作。
  return measuredStreamColumns(stream) || 80;
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

function dashboardColumns(terminalColumns) {
  const terminalWidth = Math.max(1, terminalColumns - 1);
  if (terminalColumns < 16) {
    return [{
      title: "用例状态",
      width: terminalWidth,
      value: (item) => `${item.name}: ${statusText(item.agentStatus)}`,
    }];
  }

  let caseWidth;
  let agentStatusWidth;
  let includeTest = true;
  let includeCloud = terminalColumns >= 70;
  let includeElapsed = terminalColumns >= 70;
  let tokenColumns = [];
  let compileColumns = [];

  if (terminalColumns >= 140) caseWidth = 40;
  else if (terminalColumns >= 100) caseWidth = 28;
  else if (terminalColumns >= 90) caseWidth = Math.max(16, Math.min(24, Math.floor(terminalWidth * 0.28)));
  else if (terminalColumns >= 80) caseWidth = 20;
  else if (terminalColumns >= 70) caseWidth = 17;
  else if (terminalColumns >= 60) caseWidth = 16;
  else if (terminalColumns >= 40) caseWidth = Math.max(10, Math.floor(terminalWidth * 0.28));
  else if (terminalColumns >= 32) caseWidth = 8;
  else {
    caseWidth = Math.max(4, Math.floor(terminalWidth * 0.34));
    includeTest = false;
  }

  agentStatusWidth = terminalColumns >= 70 ? 10 : terminalColumns >= 32 ? 8 : Math.max(4, Math.floor(terminalWidth * 0.28));
  const testStatusWidth = agentStatusWidth;
  const cloudTestStatusWidth = terminalColumns >= 70 ? 10 : 8;
  const elapsedWidth = terminalColumns >= 70 ? 9 : 7;
  if (terminalColumns >= 160) {
    tokenColumns = [
      { title: "输入Token", width: 11, value: (item) => formatTokenCount(item.tokenUsage.input) },
      { title: "输出Token", width: 11, value: (item) => formatTokenCount(item.tokenUsage.output) },
      { title: "总Token", width: 11, value: (item) => formatTokenCount(item.tokenUsage.total) },
    ];
    compileColumns = [{ title: "编译", width: 18, value: (item) => compileText(item.compileUsage) }];
  } else if (terminalColumns >= 120) {
    tokenColumns = [{ title: "Token(入/出/总)", width: 22, value: (item) => tokenText(item.tokenUsage) }];
  } else if (terminalColumns >= 100) {
    tokenColumns = [{ title: "总Token", width: 10, value: (item) => formatTokenCount(item.tokenUsage.total) }];
  }

  const columns = [
    { title: "用例", width: caseWidth, value: (item) => item.name },
    { title: "生成状态", width: agentStatusWidth, value: (item) => statusText(item.agentStatus) },
    ...(includeTest ? [{ title: "测试状态", width: testStatusWidth, value: (item) => statusText(item.ohosTestStatus) }] : []),
    ...(includeCloud ? [{ title: "云测试", width: cloudTestStatusWidth, value: (item) => statusText(item.cloudTestStatus) }] : []),
    ...(includeElapsed ? [{ title: "耗时", width: elapsedWidth, value: (item) => elapsed(item.startedAt, item.finishedAt || Date.now()) }] : []),
    ...tokenColumns,
    ...compileColumns,
  ];
  const separatorWidth = 2 * columns.length;
  const fixedWidth = columns.reduce((sum, column) => sum + column.width, 0);
  const activityWidth = Math.max(1, terminalWidth - fixedWidth - separatorWidth);
  columns.push({ title: "当前操作", width: activityWidth, value: (item) => item.activity });
  return columns;
}

export class ConsoleReporter {
  constructor({ batchId, cases, concurrency, batchRoot, stream = process.stdout }) {
    this.stream = stream;
    this.mode = supportsDashboard(stream) && measuredStreamColumns(stream) >= MIN_DYNAMIC_COLUMNS
      ? "dashboard"
      : "static";
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
    this.finished = false;
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
    this.stream.write(`${line}\n`);
  }

  start() {
    if (this.mode === "dashboard") {
      this.render(true);
      this.timer = setInterval(() => this.render(), 1000);
      this.timer.unref?.();
    }
  }

  caseStarted(caseName, worker) {
    const item = this.cases.get(caseName);
    if (!item) return;
    item.agentStatus = "preparing";
    item.ohosTestStatus = "not_started";
    item.cloudTestStatus = "not_started";
    Object.assign(item, { status: "preparing", phase: "agent", activity: "复制并初始化工程", startedAt: Date.now(), worker });
  }

  caseProgress(caseName, activity) {
    const item = this.cases.get(caseName);
    if (!item) return;
    item.agentStatus = "running";
    item.status = "running";
    item.phase = "agent";
    item.activity = String(activity || "Agent 运行中");
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
    this.render(true);
  }

  // ohosTest 与云测试是相互独立的任务：各自结束时立即定格自己的状态列，
  // 不等待其余分支汇总（最终 caseFinished 仍会统一覆盖一次）。
  caseOhosTestFinished(caseName, ohosTest = {}) {
    const item = this.cases.get(caseName);
    if (!item) return;
    item.ohosTestStatus = ohosTest.status || "failed";
    const errorText = String(ohosTest.error || "").replace(/\s+/g, " ").trim();
    if (item.phase !== "finished") {
      item.phase = "ohostest_finished";
      const cloudPending = item.cloudTestStatus === "queued" || item.cloudTestStatus === "running";
      item.activity = item.ohosTestStatus === "completed"
        ? (cloudPending ? "ohosTest 已完成，等待云测试" : "ohosTest 已完成")
        : `ohosTest ${statusText(item.ohosTestStatus)}${errorText ? `：${errorText}` : ""}`;
    }
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
  }

  caseCloudTestFinished(caseName, cloudResult = {}) {
    const item = this.cases.get(caseName);
    if (!item) return;
    item.cloudTestStatus = cloudResult.status || "failed";
    this.render(true);
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
    this.render(true);
  }

  caseCancelled(caseName, reason) {
    const item = this.cases.get(caseName);
    if (!item) return;
    item.agentStatus = "cancelled";
    Object.assign(item, { status: "cancelled", activity: reason, finishedAt: Date.now() });
    this.render(true);
  }

  finishWithError(reason) {
    const message = String(reason || "运行失败").replace(/\s+/g, " ").trim();
    for (const item of this.cases.values()) {
      if (["completed", "failed", "timed_out", "interrupted", "cancelled", "skipped"].includes(item.status)) continue;
      Object.assign(item, {
        status: "failed",
        agentStatus: item.agentStatus === "completed" ? item.agentStatus : "failed",
        activity: message,
        finishedAt: Date.now(),
      });
    }
    this.finish();
  }

  clearDashboard() {
    if (this.mode !== "dashboard") return;
    if (this.renderedLineCount) {
      const columns = streamColumns(this.stream);
      // 终端缩放后，现代 Windows Terminal / mintty 会按新宽度重排已经
      // 输出的行。此时按当前宽度重算物理行数，避免只清掉旧表的一部分。
      const lineCount = columns !== this.lastTerminalColumns && this.lastRenderedLines.length
        ? renderedRows(this.lastRenderedLines, columns)
        : this.renderedLineCount;
      // 使用 Node 的 TTY 光标 API，让 Windows Console、Windows Terminal 和
      // VS Code Terminal 分别走其支持的控制方式，避免原始 VT 序列被当成普通输出。
      this.stream.moveCursor(0, -lineCount);
      this.stream.cursorTo(0);
      this.stream.clearScreenDown();
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

  render(force = false, { allowNarrow = false } = {}) {
    if (this.finished || this.mode !== "dashboard" || this.dashboardPaused) return;
    const terminalColumns = streamColumns(this.stream);
    if (terminalColumns < MIN_DYNAMIC_COLUMNS && !allowNarrow) {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      this.clearDashboard();
      this.mode = "static";
      return;
    }
    // 始终保留最后一个物理列，避免 Windows Console 在写满整行时自动换行。
    // 窄终端按优先级隐藏云测试、耗时和 Token 等列。
    const terminalWidth = terminalColumns - 1;
    const columns = dashboardColumns(terminalColumns);
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
        this.stream.moveCursor(0, lineIndex - cursorLine);
        this.stream.cursorTo(0);
        if (typeof this.stream.clearLine === "function") {
          this.stream.clearLine(0);
        } else {
          this.stream.write(" ".repeat(Math.max(1, terminalWidth)));
          this.stream.cursorTo(0);
        }
        this.stream.write(lines[lineIndex]);
        cursorLine = lineIndex;
      }
      this.stream.moveCursor(0, lines.length - cursorLine);
      this.stream.cursorTo(0);
    } else {
      this.clearDashboard();
      // Keep the cursor on the line immediately after the dashboard. The next
      // refresh moves up exactly renderedLineCount lines; without this trailing
      // newline it moves one line above the dashboard and erases earlier logs.
      this.stream.write(`${output}\n`);
      this.renderedLineCount = renderedRows(lines, terminalColumns);
    }

    this.lastRendered = output;
    this.lastRenderedLines = lines;
    this.lastTerminalColumns = terminalColumns;
  }

  finish() {
    if (this.finished) return;
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
      this.finished = true;
      return;
    }
    // 非交互输出无法可靠重绘，只在结束时打印一次最终 dashboard 表格。
    this.mode = "dashboard";
    this.render(true, { allowNarrow: true });
    this.renderedLineCount = 0;
    this.lastRendered = "";
    this.mode = "static";
    this.finished = true;
  }
}

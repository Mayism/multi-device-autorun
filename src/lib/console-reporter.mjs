import process from "node:process";
import path from "node:path";
import { clearScreenDown, cursorTo, moveCursor } from "node:readline";

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
  if (count < 1000) return String(Math.round(count));
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
    this.mode = requested === "dashboard" && !process.stdout.isTTY ? "summary" : requested;
    this.requestedMode = requested;
    this.batchId = batchId;
    this.batchRoot = batchRoot;
    this.concurrency = concurrency;
    this.startedAt = Date.now();
    this.timer = null;
    this.lastRendered = "";
    this.renderedLineCount = 0;
    this.cases = new Map(cases.map((item) => [item.name, {
      name: item.name,
      status: item.skipReason ? "skipped" : "queued",
      agentStatus: item.skipReason ? "skipped" : "queued",
      ohosTestStatus: "not_started",
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
      this.write("[console] 当前输出不是交互式终端，dashboard 已自动切换为 summary");
    }
  }

  caseStarted(caseName, worker) {
    const item = this.cases.get(caseName);
    if (!item) return;
    item.agentStatus = "preparing";
    item.ohosTestStatus = "not_started";
    Object.assign(item, { status: "preparing", phase: "agent", activity: "复制并初始化工程", startedAt: Date.now(), worker });
    if (this.mode !== "dashboard") this.write(`[case:${caseName}] 开始执行（Worker ${worker}）`);
    this.render();
  }

  caseProgress(caseName, activity) {
    const item = this.cases.get(caseName);
    if (!item) return;
    item.agentStatus = "running";
    item.status = "running";
    item.phase = "agent";
    item.activity = String(activity || "Agent 运行中");
    if (this.mode === "verbose") this.write(`[case:${caseName}] ${item.activity}`);
    this.render();
  }

  caseTokenUsage(caseName, usage) {
    const item = this.cases.get(caseName);
    if (!item || !usage) return;
    item.tokenUsage = { ...usage };
    this.render();
  }

  caseCompileUsage(caseName, usage) {
    const item = this.cases.get(caseName);
    if (!item || !usage) return;
    item.compileUsage = { ...usage };
    this.render();
  }

  caseOhosTestQueued(caseName, { agentTimedOut = false } = {}) {
    const item = this.cases.get(caseName);
    if (!item) return;
    Object.assign(item, {
      status: "ohostest_queued",
      agentStatus: agentTimedOut ? "timed_out" : "completed",
      ohosTestStatus: "queued",
      phase: "ohostest_queued",
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

  caseFinished(result) {
    const item = this.cases.get(result.case);
    if (!item) return;
    const transcriptPath = result.logs?.transcriptPath || "";
    const testedAfterAgentTimeout = result.status === "completed" && result.agentStatus === "timed_out";
    Object.assign(item, {
      status: result.status,
      agentStatus: result.agentStatus || item.agentStatus,
      ohosTestStatus: result.ohosTest?.status || item.ohosTestStatus,
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
    if (this.mode !== "dashboard" || !this.renderedLineCount) return;
    if (this.renderedLineCount > 1) moveCursor(process.stdout, 0, -(this.renderedLineCount - 1));
    cursorTo(process.stdout, 0);
    clearScreenDown(process.stdout);
    this.renderedLineCount = 0;
  }

  render(force = false) {
    if (this.mode !== "dashboard") return;
    const terminalWidth = Math.max(80, process.stdout.columns || 120);
    const caseWidth = terminalWidth >= 140 ? 40 : 28;
    const agentStatusWidth = 10;
    const ohosTestStatusWidth = 10;
    const elapsedWidth = 9;
    const tokenColumns = terminalWidth >= 160
      ? [
        { title: "输入Token", width: 11, value: (item) => formatTokenCount(item.tokenUsage.input) },
        { title: "输出Token", width: 11, value: (item) => formatTokenCount(item.tokenUsage.output) },
        { title: "总Token", width: 11, value: (item) => formatTokenCount(item.tokenUsage.total) },
      ]
      : terminalWidth >= 120
        ? [{ title: "Token(入/出/总)", width: 22, value: (item) => tokenText(item.tokenUsage) }]
        : terminalWidth >= 100
          ? [{ title: "总Token", width: 10, value: (item) => formatTokenCount(item.tokenUsage.total) }]
          : [];
    const compileColumns = terminalWidth >= 160
      ? [{ title: "\u7f16\u8bd1", width: 18, value: (item) => compileText(item.compileUsage) }]
      : [];
    const fixedWidth = caseWidth + agentStatusWidth + ohosTestStatusWidth + elapsedWidth
      + tokenColumns.reduce((sum, column) => sum + column.width, 0)
      + compileColumns.reduce((sum, column) => sum + column.width, 0);
    const separatorWidth = 2 * (4 + tokenColumns.length + compileColumns.length);
    const activityWidth = Math.max(25, terminalWidth - fixedWidth - separatorWidth);
    const columns = [
      { title: "用例", width: caseWidth, value: (item) => item.name },
      { title: "生成状态", width: agentStatusWidth, value: (item) => statusText(item.agentStatus) },
      { title: "测试状态", width: ohosTestStatusWidth, value: (item) => statusText(item.ohosTestStatus) },
      { title: "耗时", width: elapsedWidth, value: (item) => elapsed(item.startedAt, item.finishedAt || Date.now()) },
      ...tokenColumns,
      ...compileColumns,
      { title: "当前操作", width: activityWidth, value: (item) => item.activity },
    ];
    const values = [...this.cases.values()];
    const skipped = values.filter((item) => item.status === "skipped").length;
    const executableTotal = values.length - skipped;
    const completed = values.filter((item) => item.status === "completed").length;
    const failed = values.filter((item) => ["failed", "timed_out", "interrupted"].includes(item.status)).length;
    const activeAgents = values.filter((item) => item.phase === "agent" && ["preparing", "running"].includes(item.status)).length;
    const activeOhosTest = values.filter((item) => item.status === "ohostest_running").length;
    const lines = [
      `Autorun 批次: ${this.batchId}   Agent: ${activeAgents}/${this.concurrency}   ohosTest: ${activeOhosTest}/1   完成: ${completed}/${executableTotal}   失败: ${failed}   跳过: ${skipped}`,
      "",
      columns.map((column) => cell(column.title, column.width)).join("  "),
      columns.map((column) => "-".repeat(column.width)).join("  "),
    ];
    for (const item of values) {
      lines.push(columns.map((column) => cell(column.value(item), column.width)).join("  "));
    }
    const output = lines.join("\n");
    if (!force && output === this.lastRendered) return;
    this.clearDashboard();
    this.lastRendered = output;
    process.stdout.write(output);
    this.renderedLineCount = lines.length;
  }

  finish(summary) {
    if (this.timer) clearInterval(this.timer);
    if (this.mode === "dashboard") {
      // 最后一次刷新后将表格留在终端中；后续摘要从下一行开始，不再回退清屏。
      this.render(true);
      process.stdout.write("\n");
      this.renderedLineCount = 0;
      this.lastRendered = "";
    }
    this.write(`[batch:${this.batchId}] 结束：成功 ${summary.completed}/${summary.total}，失败 ${summary.failed}`);
    if (summary.reports?.markdownPath) {
      this.write(`[batch:${this.batchId}] 报告：${summary.reports.markdownPath}`);
    } else {
      this.write(`[batch:${this.batchId}] 报告：生成失败${summary.reportError ? `（${summary.reportError}）` : ""}`);
    }
    const detailPath = summary.reports?.jsonPath || path.join(this.batchRoot, "summary.json");
    this.write(`[batch:${this.batchId}] 详细结果：${detailPath}`);
  }
}

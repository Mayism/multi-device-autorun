// html-report.mjs
// 将一个批次的执行结果导出为可独立浏览的 HTML 报告：
//   <batchRoot>/overview.html        总览页（所有用例一行一览，可跳转详情）
//   <batchRoot>/subpage/<Case>.html  每个用例一个详情页（总览表 + 设备/测试明细表）
//
// 数据来源：
//   summary.json        —— 用例列表、状态、时长、Token、ohosTest 结果路径
//   report.json         —— 模型/工具调用次数聚合、测试聚合
//   各 case 的 runner result.json —— 失败/错误用例的 message + stack（查看原因）
//
// 所有 HTML/CSS/JS 内联，无外部依赖；缺失文件按空数据处理，不抛错。

import fs from "node:fs/promises";
import path from "node:path";

async function readJson(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function text(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function esc(value) {
  return text(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDuration(seconds) {
  const total = Math.max(0, Math.round(num(seconds)));
  if (total <= 0) return "0s";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function fmtMs(milliseconds) {
  return fmtDuration(Math.round(num(milliseconds) / 1000));
}

function fmtToken(value) {
  const count = num(value);
  if (!count) return "0";
  const k = count / 1000;
  if (k < 10) return `${k.toFixed(2)}k`;
  if (k < 100) return `${k.toFixed(1)}k`;
  return `${Math.round(k)}k`;
}

function fmtDateTime(iso) {
  const t = text(iso).trim();
  if (!t) return "--";
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return esc(t);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const STATUS_META = {
  completed: { label: "完成", cls: "ok" },
  passed: { label: "通过", cls: "ok" },
  succeeded: { label: "成功", cls: "ok" },
  failed: { label: "失败", cls: "fail" },
  timed_out: { label: "超时", cls: "fail" },
  interrupted: { label: "中断", cls: "warn" },
  cancelled: { label: "取消", cls: "muted" },
  skipped: { label: "跳过", cls: "muted" },
  running: { label: "运行中", cls: "warn" },
  pending: { label: "等待", cls: "muted" },
  queued: { label: "排队", cls: "muted" },
  not_started: { label: "--", cls: "muted" },
};

function statusLabel(value) {
  const key = text(value).trim().toLowerCase();
  return STATUS_META[key]?.label || key || "--";
}

function statusClass(value) {
  const key = text(value).trim().toLowerCase();
  return STATUS_META[key]?.cls || "muted";
}

function badge(value) {
  return `<span class="badge badge-${statusClass(value)}">${esc(statusLabel(value))}</span>`;
}

// 测试结果带图标渲染（符号继承 CSS 颜色）：通过 ✓ / 失败 ✗ / 错误 ⊗
function testStatusHtml(value) {
  const s = text(value).trim().toLowerCase();
  if (s === "passed") return `<span class="pass">✓ 通过</span>`;
  if (s === "failed") return `<span class="fail">✗ 失败</span>`;
  if (s === "error") return `<span class="error">⊗ 错误</span>`;
  if (s === "ignored") return `<span class="muted">忽略</span>`;
  return `<span class="muted">${esc(statusLabel(s))}</span>`;
}

// 总体结果徽标：只显示文字，不带符号
function testBadge(value) {
  const s = text(value).trim().toLowerCase();
  if (s === "passed") return `<span class="badge badge-ok">通过</span>`;
  if (s === "failed") return `<span class="badge badge-fail">失败</span>`;
  if (s === "error") return `<span class="badge badge-error">错误</span>`;
  return badge(value);
}

// 对 agent 阶段时长缺失的用例（如 timed_out），用 ohosTest 开始时间反推
function deriveAgentElapsedSec(result) {
  if (result?.agentElapsedSec != null) return result.agentElapsedSec;
  const start = Date.parse(result?.startedAt || "");
  const ohosStart = Date.parse(result?.ohosTest?.startedAt || "");
  if (Number.isFinite(start) && Number.isFinite(ohosStart) && ohosStart >= start) {
    return Math.round((ohosStart - start) / 1000);
  }
  return null;
}

// 把 runner result.json 展平成每条测试一行，并附带 category / message / stack
function flattenRunnerTests(runnerResult) {
  if (!runnerResult) return [];
  const metadata = runnerResult.metadata || {};
  const failToPass = new Set((metadata.failToPass || []).map(text));
  const passToPass = new Set((metadata.passToPass || []).map(text));
  const devices = runnerResult?.runs?.swe?.devices || [];
  const rows = [];
  for (const device of devices) {
    const suites = device.suiteResults || [];
    for (const suite of suites) {
      const suiteName = text(suite.suiteClass || suite.name);
    for (const tc of suite.testCases || []) {
      const name = text(tc.name);
      // 区分 failure / error：statusCode=0 通过，-1 错误（beforeAll 超时/异常），其余为失败
      const rawStatus = text(tc.status).toLowerCase();
      const statusCode = Number(tc.statusCode);
      const status = rawStatus === "passed" || statusCode === 0
        ? "passed"
        : rawStatus === "error" || statusCode === -1
          ? "error"
          : "failed";
      rows.push({
          deviceId: text(device.id),
          deviceProfile: text(device.profile),
          suite: suiteName,
          name,
          category: failToPass.has(name)
            ? "fail_to_pass"
            : passToPass.has(name)
              ? "pass_to_pass"
              : "--",
          status,
          durationMs: num(tc.durationMs),
          message: text(tc.message),
          stack: text(tc.stack),
        });
      }
    }
  }
  return rows;
}

function summarizeTestRows(rows) {
  const summary = { testsRun: rows.length, passes: 0, failures: 0, errors: 0, ignored: 0 };
  for (const row of rows) {
    if (row.status === "passed") summary.passes += 1;
    else if (row.status === "failed") summary.failures += 1;
    else if (row.status === "error") summary.errors += 1;
    else if (row.status === "ignored") summary.ignored += 1;
  }
  const overall = summary.failures === 0 && summary.errors === 0
    ? (summary.passes > 0 ? "passed" : "not_started")
    : "failed";
  return { ...summary, status: overall };
}

// ============ 公共页面骨架 ============

function pageShell({ title, body, extraHead = "" }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style>
  :root {
    --bg: #f5f7fa; --card: #ffffff; --border: #e4e8ee; --text: #1f2733;
    --muted: #6b7785; --accent: #0a7cff; --accent-soft: #e8f1ff;
    --ok: #00b42a; --ok-soft: #e8f8ee;
    --fail: #ff7d00; --fail-soft: #fff3e8;
    --error: #f53f3f; --error-soft: #fdecec;
    --warn: #d97900; --warn-soft: #fdf2e3;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text); line-height: 1.55; font-size: 14px;
  }
  .wrap { max-width: 1400px; margin: 0 auto; padding: 24px 20px 60px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 28px 0 12px; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 18px; }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: 10px;
    box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
  }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 22px; }
  .stat { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .stat .k { color: var(--muted); font-size: 12px; }
  .stat .v { font-size: 20px; font-weight: 600; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th, td { text-align: center; padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  th { background: #fafbfc; font-weight: 600; color: #445; white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #fafcff; }
  td.num, th.num { font-variant-numeric: tabular-nums; }
  .ctr { text-align: center; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .badge-ok { background: var(--ok-soft); color: var(--ok); }
  .badge-fail { background: var(--fail-soft); color: var(--fail); }
  .badge-error { background: var(--error-soft); color: var(--error); }
  .badge-warn { background: var(--warn-soft); color: var(--warn); }
  .badge-muted { background: #eef0f3; color: var(--muted); }
  .pass { color: var(--ok); font-weight: 600; }
  .fail { color: var(--fail); font-weight: 600; }
  .error { color: var(--error); font-weight: 600; }
  .muted { color: var(--muted); }
  .mono { font-family: Consolas, "Courier New", monospace; word-break: break-all; }
  .tbl-wrap { overflow-x: auto; }
  a.link { color: var(--accent); text-decoration: none; }
  a.link:hover { text-decoration: none; opacity: 0.85; }
  .btn { display: inline-block; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--border);
    background: #fff; color: var(--text); font-size: 12.5px; cursor: pointer; }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn-reason { color: var(--error); border-color: var(--error-soft); }
  .back { margin-bottom: 16px; }
  .kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 24px; margin-bottom: 8px; }
  .kv .row { display: flex; gap: 8px; }
  .kv .row .k { color: var(--muted); flex: 0 1 112px; min-width: 0; text-align: right; white-space: normal; word-break: keep-all; overflow-wrap: break-word; }
  .kv .row .k::after { content: "："; }
  .kv .row > span:last-child { white-space: nowrap; }
  .modal-mask { display: none; position: fixed; inset: 0; background: rgba(16,24,40,.45); z-index: 100; padding: 30px 16px; overflow: auto; }
  .modal-mask.open { display: flex; align-items: flex-start; justify-content: center; }
  .modal { background: #fff; border-radius: 12px; max-width: 920px; width: 100%; box-shadow: 0 12px 40px rgba(0,0,0,.2); }
  .modal-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--border); }
  .modal-head .t { font-weight: 600; }
  .modal-body { padding: 16px 18px; max-height: 70vh; overflow: auto; }
  .modal-body section { margin-bottom: 16px; }
  .modal-body h4 { margin: 0 0 6px; font-size: 13px; color: var(--muted); }
  .reason-msg { white-space: pre-wrap; word-break: break-word; background: var(--fail-soft); color: #8a262a; padding: 10px 12px; border-radius: 8px; }
  pre.stack { white-space: pre-wrap; word-break: break-word; background: #0f172a; color: #e5e7eb; padding: 12px; border-radius: 8px; font-size: 12px; line-height: 1.5; }
  .legend { color: var(--muted); font-size: 12.5px; margin: 8px 0 0; }
  .empty { color: var(--muted); padding: 20px; text-align: center; }
</style>
${extraHead}
</head>
<body>
<div class="wrap">${body}</div>
</body>
</html>`;
}

function modalScript() {
  return `<script>
  (function () {
    const reasons = window.__REASONS__ || {};
    const mask = document.getElementById('reasonMask');
    const titleEl = document.getElementById('reasonTitle');
    const msgEl = document.getElementById('reasonMsg');
    const stackEl = document.getElementById('reasonStack');
    function open(id) {
      const r = reasons[id];
      if (!r) return;
      titleEl.textContent = r.title;
      msgEl.textContent = r.message || '（无失败描述）';
      stackEl.textContent = r.stack || '';
      stackEl.style.display = r.stack ? 'block' : 'none';
      mask.classList.add('open');
    }
    function close() { mask.classList.remove('open'); }
    window.__openReason = open;
    window.__closeReason = close;
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  })();
  </script>`;
}

function reasonModalMarkup() {
  return `<div class="modal-mask" id="reasonMask">
    <div class="modal">
      <div class="modal-head"><span class="t" id="reasonTitle">失败原因</span><button class="btn" onclick="window.__closeReason()">关闭</button></div>
      <div class="modal-body">
        <section><h4>失败描述</h4><div class="reason-msg" id="reasonMsg"></div></section>
        <section><h4>调用栈</h4><pre class="stack" id="reasonStack"></pre></section>
      </div>
    </div>
  </div>`;
}

// ============ 总览页 ============

function buildOverview({ summary, report, caseRows, executionInfo }) {
  const batch = summary || {};
  const agentTotals = report?.agent || {};
  const ohosTotals = report?.ohosTest || {};
  const agentType = text(batch.agent || agentTotals.type || executionInfo?.agent);
  const providerId = text(batch.providerId || agentTotals.providerId || executionInfo?.providerId);
  const modelId = text(batch.modelId || agentTotals.modelId || executionInfo?.modelId);
  const model = [providerId, modelId].filter(Boolean).join("/");

  const statCards = [
    { k: "用例总数", v: batch.total ?? caseRows.length ?? "--" },
    { k: "完成 / 失败", v: `${batch.completed ?? 0} / ${batch.failed ?? 0}` },
    { k: "总 Token", v: fmtToken(batch.tokenUsage?.total) },
    { k: "模型调用", v: agentTotals.modelCalls ?? "--" },
    { k: "工具调用", v: agentTotals.toolCalls ?? "--" },
    { k: "执行用例个数", v: ohosTotals.testsRun ?? "--" },
    { k: "通过 / 失败 / 错误", v: `<span class="pass">${ohosTotals.passes ?? 0}</span> / <span class="fail">${ohosTotals.failures ?? 0}</span> / <span class="error">${ohosTotals.errors ?? 0}</span>`, html: true },
  ];

  const agentName = text(executionInfo?.agent || batch.agent);
  const modelName = text(executionInfo?.modelId || batch.modelId);

  const head = `
    <h1>Autorun 批次执行总览</h1>
    <h2>配置总览</h2>
    <div class="stats">
      <div class="stat"><div class="k">Agent</div><div class="v">${esc(agentName || "--")}</div></div>
      <div class="stat"><div class="k">模型</div><div class="v">${esc(modelName || "--")}</div></div>
    </div>
    <h2>结果总览</h2>
    <div class="stats">${statCards.map((s) => `<div class="stat"><div class="k">${esc(s.k)}</div><div class="v">${s.html ? s.v : esc(s.v)}</div></div>`).join("")}</div>`;

  const rowsHtml = caseRows.map((c) => {
    const testName = encodeURIComponent(`${c.case}.html`);
    return `<tr>
      <td><a class="link" href="subpage/${testName}">${esc(c.case)}</a></td>
      <td>${fmtDateTime(c.startedAt)}</td>
      <td>${fmtDateTime(c.finishedAt)}</td>
      <td class="num">${fmtDuration(c.elapsedSec)}</td>
      <td class="num">${fmtDuration(c.agentElapsedSec)}</td>
      <td class="num">${fmtDuration(c.ohosTestElapsedSec)}</td>
      <td class="num">${c.modelCalls ?? "--"}<span class="muted">/${c.toolCalls ?? "--"}</span></td>
      <td class="num" title="输入 ${fmtToken(c.tokenIn)} / 输出 ${fmtToken(c.tokenOut)} / 推理 ${fmtToken(c.tokenReasoning)} / 缓存 ${fmtToken(c.tokenCacheRead)}">${fmtToken(c.tokenTotal)}</td>
      <td>${badge(c.status)}</td>
      <td>${c.testSummary}</td>
      <td><a class="link" href="subpage/${testName}">查看详情</a></td>
    </tr>`;
  }).join("");

  const table = `
    <h2>用例执行一览</h2>
    <div class="card tbl-wrap">
      <table>
        <thead><tr>
          <th>测试用例名称</th>
          <th>开始时间</th>
          <th>结束时间</th>
          <th class="num">总耗时</th>
          <th class="num">Agent执行耗时</th>
          <th class="num">用例执行耗时</th>
          <th class="num">交互(模型/工具)</th>
          <th class="num">Token 消耗</th>
          <th>测试结果</th>
          <th>执行结果</th>
          <th>操作</th>
        </tr></thead>
        <tbody>${rowsHtml || `<tr><td colspan="11" class="empty">暂无用例数据</td></tr>`}</tbody>
      </table>
    </div>
    <p class="legend">说明：「Agent执行耗时」为 Agent 改造代码阶段；「用例执行耗时」为 ohosTest 设备测试阶段；「总耗时」≈「Agent执行耗时」+「用例执行耗时」（相差不超过 1 秒为时间取整）；「交互(模型/工具)」为模型调用次数 / 工具调用次数。</p>`;

  return pageShell({ title: `批次总览 · ${batch.batchId || ""}`, body: head + table });
}

// ============ 详情页 ============

function buildCasePage({ caseName, caseResult, agentMetrics, runnerResult, testRows, executionInfo }) {
  const r = caseResult || {};
  const am = agentMetrics || {};
  const agentType = text(r.agent || executionInfo?.agent);
  const providerId = text(r.providerId || executionInfo?.providerId);
  const modelId = text(r.modelId || executionInfo?.modelId);
  const model = [providerId, modelId].filter(Boolean).join("/");
  const overview = summarizeTestRows(testRows);

  const back = `<div class="back"><a class="link" href="../overview.html">← 返回总览</a></div>`;
  const head = `
    <h1>${esc(caseName)}</h1>`;

  const agentCard = `
    <h2>执行信息</h2>
    <div class="card" style="padding:16px 18px;">
      <div class="kv">
        <div class="row"><span class="k">Agent 状态</span><span>${badge(r.agentStatus || am.status)}</span></div>
        <div class="row"><span class="k">开始时间</span><span>${fmtDateTime(r.startedAt)}</span></div>
        <div class="row"><span class="k">结束时间</span><span>${fmtDateTime(r.finishedAt)}</span></div>
        <div class="row"><span class="k">总耗时</span><span>${fmtDuration(r.elapsedSec)}</span></div>
        <div class="row"><span class="k">Agent执行耗时</span><span>${fmtDuration(deriveAgentElapsedSec(r) ?? am.elapsedSec)}</span></div>
        <div class="row"><span class="k">用例执行耗时</span><span>${fmtDuration(r.ohosTest?.elapsedSec)}</span></div>
        ${r.ohosTest?.workDir ? `<div class="row" style="grid-column:1/-1"><span class="k">ohosTest 工作目录</span><span class="mono">${esc(r.ohosTest.workDir)}</span></div>` : ""}
        <div class="row"><span class="k">模型/工具调用</span><span>${am.modelCalls ?? "--"} / ${am.toolCalls ?? "--"}</span></div>
        <div class="row"><span class="k">输入 Token</span><span>${fmtToken(r.tokenUsage?.input)}</span></div>
        <div class="row"><span class="k">输出 Token</span><span>${fmtToken(r.tokenUsage?.output)}</span></div>
        <div class="row"><span class="k">推理 Token</span><span>${fmtToken(r.tokenUsage?.reasoning)}</span></div>
        <div class="row"><span class="k">缓存读取</span><span>${fmtToken(r.tokenUsage?.cacheRead)}</span></div>
        <div class="row"><span class="k">合计 Token</span><span title="合计 = 输入 + 输出 + 推理 + 缓存读取 + 缓存写入"><b>${fmtToken(r.tokenUsage?.total)}</b></span></div>
        ${r.agentError ? `<div class="row" style="grid-column:1/-1"><span class="k">Agent 错误</span><span class="error">${esc(r.agentError)}</span></div>` : ""}
      </div>
    </div>`;

  // 表 1：总览（横向：总数 / 通过 / 失败 / 错误 / 总体结果）
  const overviewTable = `
    <h2>测试总览</h2>
    <div class="card tbl-wrap">
      <table>
        <thead><tr>
          <th class="ctr">总数</th><th class="ctr">通过</th><th class="ctr">失败</th><th class="ctr">错误</th><th class="ctr">总体结果</th>
        </tr></thead>
        <tbody><tr>
          <td class="ctr">${overview.testsRun}</td>
          <td class="ctr pass">✓ ${overview.passes}</td>
          <td class="ctr fail">✗ ${overview.failures}</td>
          <td class="ctr error">⊗ ${overview.errors}</td>
          <td class="ctr">${testBadge(overview.status)}</td>
        </tr></tbody>
      </table>
    </div>`;

  // 表 2：明细
  let reasonIndex = 0;
  const reasons = {};
  const detailBody = testRows.length
    ? testRows.map((row) => {
        const isFail = row.status === "failed" || row.status === "error";
        const reasonId = isFail && (row.message || row.stack) ? `r${reasonIndex++}` : null;
        if (reasonId) {
          reasons[reasonId] = {
            title: `${row.deviceProfile || row.deviceId} · ${row.name}`,
            message: row.message,
            stack: row.stack,
          };
        }
        const statusHtml = testStatusHtml(row.status);
        const actionHtml = reasonId
          ? `<button class="btn btn-reason" onclick="window.__openReason('${reasonId}')">查看原因</button>`
          : isFail ? `<span class="muted">无详情</span>` : "--";
        return `<tr>
          <td>${esc(row.deviceProfile || row.deviceId)}<span class="muted"> / ${esc(row.deviceId)}</span></td>
          <td>${esc(row.suite)}</td>
          <td>${esc(row.name)}</td>
          <td>${esc(row.category)}</td>
          <td>${statusHtml}</td>
          <td class="num">${Math.round(row.durationMs)} ms</td>
          <td>${actionHtml}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="7" class="empty">无设备测试数据（可能未启用 ohosTest 或 Agent 阶段已失败）</td></tr>`;

  const detailTable = `
    <h2>设备测试明细</h2>
    <div class="card tbl-wrap">
      <table>
        <thead><tr>
          <th>设备名称</th><th>测试类</th><th>测试用例</th><th>类别</th>
          <th>结果</th><th class="num">耗时</th><th>操作</th>
        </tr></thead>
        <tbody>${detailBody}</tbody>
      </table>
    </div>`;

  const extraHead = `<script>window.__REASONS__ = ${JSON.stringify(reasons)};</script>`;
  const body = back + head + agentCard + overviewTable + detailTable + reasonModalMarkup();
  return pageShell({ title: `${caseName} · 详情`, body, extraHead }) + modalScript();
}

// ============ 主入口 ============

export async function writeHtmlReport({ batchRoot, summary }) {
  const report = await readJson(path.join(batchRoot, "report.json"));
  const results = Array.isArray(summary?.results) ? summary.results : [];
  const representativeResult = results.find((item) => item?.agent || item?.providerId || item?.modelId) || {};
  const executionInfo = {
    agent: text(summary?.agent || report?.agent?.type || representativeResult.agent),
    providerId: text(summary?.providerId || report?.agent?.providerId || representativeResult.providerId),
    modelId: text(summary?.modelId || report?.agent?.modelId || representativeResult.modelId),
  };

  // report.json 中按用例名的 agent 指标索引
  const agentByCase = new Map(
    (report?.agent?.cases || []).map((c) => [text(c.case), c]),
  );
  const ohosByCase = new Map(
    (report?.ohosTest?.caseResults || []).map((c) => [text(c.case), c]),
  );

  const caseRows = [];
  for (const result of results) {
    const caseName = text(result.case);
    const am = agentByCase.get(caseName) || {};
    const runnerResult = await readJson(result?.ohosTest?.resultPath || "");
    const testRows = flattenRunnerTests(runnerResult);
    const ts = summarizeTestRows(testRows);
    caseRows.push({
      case: caseName,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      elapsedSec: result.elapsedSec,
      agentElapsedSec: deriveAgentElapsedSec(result) ?? am.elapsedSec,
      ohosTestElapsedSec: result?.ohosTest?.elapsedSec,
      modelCalls: am.modelCalls,
      toolCalls: am.toolCalls,
      tokenIn: result?.tokenUsage?.input,
      tokenOut: result?.tokenUsage?.output,
      tokenReasoning: result?.tokenUsage?.reasoning,
      tokenCacheRead: result?.tokenUsage?.cacheRead,
      tokenTotal: result?.tokenUsage?.total,
      status: result.status,
      testSummary: testRows.length
        ? `<span class="pass">✓ ${ts.passes}</span> / <span class="fail">✗ ${ts.failures}</span> / <span class="error">⊗ ${ts.errors}</span>`
        : (result?.ohosTest?.status ? badge(result.ohosTest.status) : "--"),
    });
  }

  // 写 overview.html
  const overviewHtml = buildOverview({ summary, report, caseRows, executionInfo });
  await fs.writeFile(path.join(batchRoot, "overview.html"), overviewHtml, "utf8");

  // 写 subpage/<case>.html
  const subpageDir = path.join(batchRoot, "subpage");
  await fs.mkdir(subpageDir, { recursive: true });
  const written = [];
  for (const result of results) {
    const caseName = text(result.case);
    const am = agentByCase.get(caseName) || {};
    const runnerResult = await readJson(result?.ohosTest?.resultPath || "");
    const testRows = flattenRunnerTests(runnerResult);
    const html = buildCasePage({
      caseName,
      caseResult: result,
      agentMetrics: am,
      runnerResult,
      testRows,
      executionInfo,
    });
    const filePath = path.join(subpageDir, `${caseName}.html`);
    await fs.writeFile(filePath, html, "utf8");
    written.push(filePath);
  }

  return {
    overviewPath: path.join(batchRoot, "overview.html"),
    subpageDir,
    casePages: written,
  };
}

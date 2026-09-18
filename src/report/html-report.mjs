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
import { failureIdentity } from "../agent/uitest-failure-analysis.mjs";

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

// Agent 来源分类（值与批次分层目录名一致，见 autorun.mjs resolveBatchModeDirectoryName）：
//   harmonyBot         → 自研：使用 huaweideveloperserviceplatform.harmonyosdevassistantforvscode-* 插件
//   softwareEngineering → 软工：software-multi-device，opencode 来源含 Skills
//   baseModel          → 裸模：software-multi-device，opencode 来源无 Skills
const AGENT_SOURCE_LABELS = { harmonyBot: "自研", softwareEngineering: "软工", baseModel: "裸模" };

export function agentSourceLabel(mode) {
  return AGENT_SOURCE_LABELS[text(mode).trim()] || "";
}

// 展示为「agent名称/（自研｜软工｜裸模）」；分类未知时仅展示名称
export function agentDisplayName(agent, mode) {
  const name = text(agent).trim();
  const label = agentSourceLabel(mode);
  return name && label ? `${name}/${label}` : name;
}

// 解析批次 Agent 来源分类：优先 summary 记录值（新批次），
// 其次批次所在分层目录名（harmonyBot/softwareEngineering/baseModel），
// 旧扁平布局无分层信息时按 Agent 名兜底（harmonyos-multi-device 仅由自研插件提供）
export function resolveAgentSourceMode({ summary, batchRoot, relPath, agent }) {
  const recorded = text(summary?.opencodeSourceMode).trim();
  if (recorded) return recorded;
  const rel = text(relPath).trim().replace(/\\/g, "/");
  const layer = rel.includes("/") ? rel.split("/")[0] : "";
  const parent = layer || path.basename(path.dirname(path.resolve(batchRoot)));
  if (Object.hasOwn(AGENT_SOURCE_LABELS, parent)) return parent;
  const agentName = text(agent ?? summary?.agent).trim();
  if (agentName === "harmonyos-multi-device") return "harmonyBot";
  return "";
}

export function esc(value) {
  return text(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function fmtDuration(seconds) {
  const total = Math.max(0, Math.round(num(seconds)));
  if (total <= 0) return "0s";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function fmtMs(milliseconds) {
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

export function fmtDateTime(iso) {
  const t = text(iso).trim();
  if (!t) return "--";
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return esc(t);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export const STATUS_META = {
  completed: { label: "完成", cls: "ok" },
  passed: { label: "通过", cls: "ok" },
  succeeded: { label: "成功", cls: "ok" },
  failed: { label: "失败", cls: "fail" },
  timed_out: { label: "超时", cls: "fail" },
  rate_limited: { label: "限额", cls: "fail" },
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

export function badge(value) {
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

export function pageShell({ title, body, extraHead = "" }) {
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
  .compile-card { display: flex; align-items: center; gap: 28px; padding: 16px 18px; }
  .compile-total { min-width: 130px; padding-right: 28px; border-right: 1px solid var(--border); }
  .compile-total .k, .compile-item .k { color: var(--muted); font-size: 12px; }
  .compile-total .v { margin-top: 2px; font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .compile-breakdown { display: grid; grid-template-columns: repeat(4, minmax(72px, 1fr)); gap: 16px 28px; flex: 1; }
  .compile-item .v { margin-top: 2px; font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
  @media (max-width: 640px) {
    .compile-card { align-items: stretch; flex-direction: column; gap: 14px; }
    .compile-total { padding: 0 0 14px; border-right: 0; border-bottom: 1px solid var(--border); }
    .compile-breakdown { grid-template-columns: repeat(2, minmax(72px, 1fr)); }
  }
  .modal-mask { display: none; position: fixed; inset: 0; background: rgba(16,24,40,.45); z-index: 100; padding: 30px 16px; overflow: auto; }
  .modal-mask.open { display: flex; align-items: flex-start; justify-content: center; }
  .modal { background: #fff; border-radius: 12px; max-width: 920px; width: 100%; box-shadow: 0 12px 40px rgba(0,0,0,.2); }
  .modal-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--border); }
  .modal-head .t { font-weight: 600; }
  .modal-body { padding: 16px 18px; max-height: 70vh; overflow: auto; }
  .modal-body section { margin-bottom: 16px; }
  .modal-body h4 { margin: 0 0 6px; font-size: 13px; color: var(--muted); }
  .reason-msg { white-space: pre-wrap; word-break: break-word; background: var(--fail-soft); color: #8a262a; padding: 10px 12px; border-radius: 8px; }
  .interaction-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; overflow: hidden; background: var(--border); border: 1px solid var(--border); border-radius: 8px; }
  .interaction-item { min-width: 0; padding: 10px 12px; background: #fff; }
  .interaction-item .k { margin-bottom: 3px; color: var(--muted); font-size: 12px; }
  .interaction-item .v { word-break: break-word; font-size: 13px; }
  @media (max-width: 640px) { .interaction-grid { grid-template-columns: 1fr; } }
  .modal-body details { border-top: 1px solid var(--border); padding-top: 12px; }
  .modal-body summary { color: var(--muted); cursor: pointer; margin-bottom: 12px; }
  .modal-body ul { margin: 0; padding-left: 20px; }
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
    const expectedEl = document.getElementById('reasonExpected');
    const actualEl = document.getElementById('reasonActual');
    const technicalEl = document.getElementById('reasonTechnical');
    const interactionSectionEl = document.getElementById('reasonInteractionSection');
    const interactionEl = document.getElementById('reasonInteraction');
    const rawMessageEl = document.getElementById('reasonRawMessage');
    const categoryEl = document.getElementById('reasonCategory');
    const evidenceEl = document.getElementById('reasonEvidence');
    const suggestionEl = document.getElementById('reasonSuggestion');
    const rawDetailsEl = document.getElementById('reasonRawDetails');
    const stackEl = document.getElementById('reasonStack');
    function open(id) {
      const r = reasons[id];
      if (!r) return;
      titleEl.textContent = r.title;
      msgEl.textContent = r.analysis || '自动分析结果未与该失败项匹配，请展开技术详情查看原始信息。';
      expectedEl.textContent = r.expectedBehavior || '';
      expectedEl.parentElement.style.display = r.expectedBehavior ? 'block' : 'none';
      actualEl.textContent = r.actualBehavior || '';
      actualEl.parentElement.style.display = r.actualBehavior ? 'block' : 'none';
      technicalEl.textContent = r.technicalCause || '';
      technicalEl.parentElement.style.display = r.technicalCause ? 'block' : 'none';
      interactionEl.innerHTML = '';
      const interaction = r.interaction;
      if (interaction) {
        const actionLabels = { click: '点击', longClick: '长按', inputText: '输入文本', interact: '交互' };
        const locatorLabels = { id: 'ID', text: '文本', type: '控件类型', description: '描述', key: 'Key' };
        const target = interaction.target || {};
        const result = interaction.result || {};
        const assertion = interaction.assertion || {};
        const rows = [
          ['失败阶段', interaction.phase],
          ['操作', actionLabels[interaction.action] || interaction.action],
          ['定位方式', locatorLabels[interaction.locator && interaction.locator.type] || (interaction.locator && interaction.locator.type)],
          ['Selector', interaction.locator && interaction.locator.value],
          ['目标控件', target.componentType ? ((target.clickable ? '可点击 ' : '') + target.componentType + ' 控件') : '未解析'],
          ['控件文案', target.displayText || '未解析'],
          ['查找结果', result.status === 'not_found' ? ('未找到' + (result.returnedValue ? '，返回 ' + result.returnedValue : '')) : result.status],
          ['业务断言', assertion.executed === false ? ('未执行' + (assertion.expression ? '：' + assertion.expression : '')) : '已执行'],
        ];
        rows.forEach(function (row) {
          if (!row[1]) return;
          const item = document.createElement('div'); item.className = 'interaction-item';
          const key = document.createElement('div'); key.className = 'k'; key.textContent = row[0];
          const value = document.createElement('div'); value.className = 'v'; value.textContent = row[1];
          item.appendChild(key); item.appendChild(value); interactionEl.appendChild(item);
        });
      }
      interactionSectionEl.style.display = interaction ? 'block' : 'none';
      rawMessageEl.textContent = r.message || '（无原始失败描述）';
      categoryEl.textContent = r.analysis
        ? ((r.categoryLabel || '原因待确认') + ' · 置信度 ' + (r.confidenceLabel || '低'))
        : '自动分析不可用，以下为原始失败信息';
      evidenceEl.innerHTML = '';
      (r.evidence || []).forEach(function (value) {
        const li = document.createElement('li'); li.textContent = value; evidenceEl.appendChild(li);
      });
      evidenceEl.parentElement.style.display = r.evidence && r.evidence.length ? 'block' : 'none';
      suggestionEl.textContent = r.suggestion || '';
      suggestionEl.parentElement.style.display = r.suggestion ? 'block' : 'none';
      stackEl.textContent = r.stack || '';
      stackEl.style.display = r.stack ? 'block' : 'none';
      rawDetailsEl.open = !r.analysis;
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
        <section><h4 id="reasonCategory">具体原因</h4><div class="reason-msg" id="reasonMsg"></div></section>
        <section id="reasonInteractionSection"><h4>失败交互</h4><div class="interaction-grid" id="reasonInteraction"></div></section>
        <section><h4>预期用户体验</h4><div id="reasonExpected"></div></section>
        <section><h4>实际用户体验</h4><div id="reasonActual"></div></section>
        <section><h4>技术原因</h4><div id="reasonTechnical"></div></section>
        <section><h4>分析依据</h4><ul id="reasonEvidence"></ul></section>
        <section><h4>建议</h4><div id="reasonSuggestion"></div></section>
        <details id="reasonRawDetails"><summary>原始错误与调用栈（技术详情）</summary>
          <section><h4>原始失败描述</h4><div class="reason-msg" id="reasonRawMessage"></div></section>
          <section><h4>调用栈</h4><pre class="stack" id="reasonStack"></pre></section>
        </details>
      </div>
    </div>
  </div>`;
}

// ============ 白盒评价 / 云测试章节（批次总览页与跨批次合并页共用） ============

// 产物绝对路径转相对链接（相对页面所在目录；分 segment 编码，兼容中文与空格）
function relHref(pageDir, targetPath) {
  const target = text(targetPath).trim();
  if (!target) return "";
  let rel = "";
  try {
    rel = path.relative(path.resolve(pageDir), path.resolve(pageDir, target));
  } catch {
    return "";
  }
  if (!rel) return "";
  return rel.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
}

// 白盒评价行：数据取 summary.results[].whitebox（编排器写入的完整值，
// 含 status/totalScore/judge/reportPath），reportPath 指向单文件 HTML 详情页。
// enabled=false（阶段明确关闭）时返回空数组，忽略历史残留数据
export function collectWhiteboxRows(results, pageDir, { enabled } = {}) {
  if (enabled === false) return [];
  const rows = [];
  for (const result of Array.isArray(results) ? results : []) {
    const whitebox = result?.whitebox;
    if (!whitebox) continue;
    const score = Number(whitebox.totalScore);
    rows.push({
      case: text(whitebox.case) || text(result?.case),
      status: text(whitebox.status),
      totalScore: Number.isFinite(score) ? score : null,
      judge: [text(whitebox.judge?.providerId), text(whitebox.judge?.modelId)].filter(Boolean).join("/"),
      hardGateTriggered: whitebox.hardGateTriggered === true,
      error: text(whitebox.error),
      detailHref: relHref(pageDir, whitebox.reportPath),
    });
  }
  return rows;
}

// 云测试行：result.cloudTest 提供状态/任务组；设备与规则指标读
// outputDir/cloudtest-result.json 的 report.summary（结构化摘要，失败或旧数据可能缺失）。
// enabled=false（阶段明确关闭）时忽略历史残留数据，返回空行集与零值合计
export async function collectCloudTestRows(results, pageDir, { enabled } = {}) {
  const emptyTotals = { cases: 0, devicePassed: 0, deviceFailed: 0, rulePassed: 0, ruleFailed: 0, issueCount: 0 };
  if (enabled === false) return { rows: [], totals: emptyTotals };
  const rows = [];
  const totals = emptyTotals;
  for (const result of Array.isArray(results) ? results : []) {
    const cloud = result?.cloudTest;
    if (!cloud) continue;
    totals.cases += 1;
    const run = await readJson(cloud.outputDir ? path.join(cloud.outputDir, "cloudtest-result.json") : "");
    const summary = run?.report?.summary && typeof run.report.summary === "object" ? run.report.summary : null;
    if (summary) {
      totals.devicePassed += num(summary.devicePassed);
      totals.deviceFailed += num(summary.deviceFailed);
      totals.rulePassed += num(summary.rulePassed);
      totals.ruleFailed += num(summary.ruleFailed);
      totals.issueCount += num(summary.issueCount);
    }
    const htmlPath = text(run?.report?.htmlPath) || (cloud.outputDir ? path.join(cloud.outputDir, "cloudtest-report.html") : "");
    rows.push({
      case: text(result?.case),
      status: text(cloud.status),
      taskGroupId: text(cloud.taskGroupId),
      taskName: text(cloud.taskName),
      error: text(cloud.error) || text(run?.error),
      summary,
      reportHref: htmlPath && await pathExists(htmlPath) ? relHref(pageDir, htmlPath) : "",
    });
  }
  return { rows, totals };
}

export function buildWhiteboxSection({ rows, showWhenEmpty = false }) {
  if (!rows.length && !showWhenEmpty) return "";
  const bodyHtml = rows.length
    ? rows.map((row) => `<tr>
        <td style="text-align:left">${esc(row.case)}</td>
        <td${row.error ? ` title="${esc(row.error)}"` : ""}>${badge(row.status)}</td>
        <td class="num"${row.hardGateTriggered ? ' title="已触发硬门槛封顶"' : ""}>${row.totalScore == null ? "--" : esc(row.totalScore)}</td>
        <td>${esc(row.judge || "--")}</td>
        <td>${row.detailHref ? `<a class="link" href="${esc(row.detailHref)}">详情</a>` : "--"}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" class="empty">暂无白盒评价数据（用例均未进入白盒评价阶段）</td></tr>`;
  return `
    <h2>白盒评价</h2>
    <div class="card tbl-wrap">
      <table>
        <thead><tr>
          <th>用例名称</th><th>状态</th><th class="num">总分</th><th>裁判模型</th><th>操作</th>
        </tr></thead>
        <tbody>${bodyHtml}</tbody>
      </table>
    </div>`;
}

// 单用例结果概要：设备/规则通过比 + 问题数（summary 缺失时回退 --）
function cloudSummaryHtml(summary) {
  if (!summary) return `<span class="muted">--</span>`;
  const deviceTotal = num(summary.deviceCount) || num(summary.devicePassed) + num(summary.deviceFailed);
  const ruleTotal = num(summary.rulePassed) + num(summary.ruleFailed);
  const issues = num(summary.issueCount);
  return `设备 <span class="pass">${num(summary.devicePassed)}</span>/<span class="muted">${deviceTotal}</span> 通过 · 规则 <span class="pass">${num(summary.rulePassed)}</span>/<span class="muted">${ruleTotal}</span> 通过 · 问题 <span class="${issues ? "error" : "muted"}">${issues}</span>`;
}

export function buildCloudTestSection({ rows, totals, showWhenEmpty = false }) {
  if (!rows.length && !showWhenEmpty) return "";
  const cards = [
    { k: "参与用例", v: totals?.cases ?? rows.length },
    { k: "设备通过", v: totals?.devicePassed ?? 0 },
    { k: "设备失败", v: totals?.deviceFailed ?? 0 },
    { k: "规则通过", v: totals?.rulePassed ?? 0 },
    { k: "规则失败", v: totals?.ruleFailed ?? 0 },
    { k: "问题数量", v: totals?.issueCount ?? 0 },
  ];
  const bodyHtml = rows.length
    ? rows.map((row) => `<tr>
        <td style="text-align:left">${esc(row.case)}</td>
        <td${row.error ? ` title="${esc(row.error)}"` : ""}>${badge(row.status)}</td>
        <td class="mono">${esc(row.taskGroupId || "--")}</td>
        <td>${cloudSummaryHtml(row.summary)}</td>
        <td>${row.reportHref ? `<a class="link" href="${esc(row.reportHref)}">云测试报告</a>` : "--"}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" class="empty">暂无云测试数据（云测试阶段未执行或未产生结果）</td></tr>`;
  return `
    <h2>云测试</h2>
    <div class="stats">${cards.map((s) => `<div class="stat"><div class="k">${esc(s.k)}</div><div class="v">${esc(s.v)}</div></div>`).join("")}</div>
    <div class="card tbl-wrap">
      <table>
        <thead><tr>
          <th>用例名称</th><th>状态</th><th>任务组</th><th>结果概要</th><th>操作</th>
        </tr></thead>
        <tbody>${bodyHtml}</tbody>
      </table>
    </div>`;
}

// ============ 总览页 ============

// 导出供跨批次合并复用（仅增加 export，逻辑与单批次报告完全一致）；
// whitebox / cloudTest 为可选章节数据，未传或未启用时对应章节省略
export function buildOverview({
  summary,
  report,
  caseRows,
  executionInfo,
  whitebox = { rows: [] },
  cloudTest = { rows: [], totals: {} },
}) {
  const batch = summary || {};
  const agentTotals = report?.agent || {};
  const ohosTotals = report?.ohosTest || {};
  const whiteboxTotals = report?.whitebox || {};
  const agentType = text(batch.agent || agentTotals.type || executionInfo?.agent);
  const providerId = text(batch.providerId || agentTotals.providerId || executionInfo?.providerId);
  const modelId = text(batch.modelId || agentTotals.modelId || executionInfo?.modelId);
  const model = [providerId, modelId].filter(Boolean).join("/");
  // 批次级通过率：通过 / (通过+失败+错误)，百分比取整
  const passDenom = (ohosTotals.passes ?? 0) + (ohosTotals.failures ?? 0) + (ohosTotals.errors ?? 0);
  const passRate = passDenom > 0 ? `${Math.round(((ohosTotals.passes ?? 0) / passDenom) * 100)}%` : "--";

  const statCards = [
    { k: "用例总数", v: batch.total ?? caseRows.length ?? "--" },
    { k: "完成 / 失败", v: `${batch.completed ?? 0} / ${batch.failed ?? 0}` },
    { k: "总 Token", v: fmtToken(batch.tokenUsage?.total) },
    { k: "模型调用", v: agentTotals.modelCalls ?? "--" },
    { k: "工具调用", v: agentTotals.toolCalls ?? "--" },
    { k: "执行用例个数", v: ohosTotals.testsRun ?? "--" },
    { k: "通过 / 失败 / 错误", v: `<span class="pass">${ohosTotals.passes ?? 0}</span> / <span class="fail">${ohosTotals.failures ?? 0}</span> / <span class="error">${ohosTotals.errors ?? 0}</span>`, html: true },
    { k: "通过率", v: passRate },
    { k: "白盒完成 / 失败", v: `${whiteboxTotals.completed ?? 0} / ${whiteboxTotals.failed ?? 0}` },
    { k: "白盒平均分", v: whiteboxTotals.averageScore ?? "--" },
  ];

  const agentName = agentDisplayName(executionInfo?.agent || batch.agent, executionInfo?.sourceMode);
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
      <td style="text-align:left"><a class="link" href="subpage/${testName}">${esc(c.case)}</a></td>
      <td>${fmtDateTime(c.startedAt)}</td>
      <td>${fmtDateTime(c.finishedAt)}</td>
      <td class="num">${fmtDuration(c.elapsedSec)}</td>
      <td class="num">${fmtDuration(c.agentElapsedSec)}</td>
      <td class="num">${fmtDuration(c.ohosTestElapsedSec)}</td>
      <td class="num">${c.modelCalls ?? "--"}<span class="muted">/${c.toolCalls ?? "--"}</span></td>
      <td class="num" title="输入 ${fmtToken(c.tokenIn)} / 输出 ${fmtToken(c.tokenOut)} / 推理 ${fmtToken(c.tokenReasoning)} / 缓存 ${fmtToken(c.tokenCacheRead)}">${fmtToken(c.tokenTotal)}</td>
      <td>${badge(c.status)}</td>
      <td>${c.testSummary}</td>
      <td class="num">${c.passRate}</td>
      <td><a class="link" href="subpage/${testName}">查看详情</a>${c.downloadUrl ? ` <a class="link" href="${esc(c.downloadUrl)}" target="_blank">下载</a>` : ""}</td>
    </tr>`;
  }).join("");

  const table = `
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <h2>用例执行一览</h2>
      <button class="btn" onclick="exportCases()" title="导出 Excel" style="padding:6px 10px"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
    </div>
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
          <th class="num">通过率</th>
          <th>操作</th>
        </tr></thead>
        <tbody>${rowsHtml || `<tr><td colspan="12" class="empty">暂无用例数据</td></tr>`}</tbody>
      </table>
    </div>
    <p class="legend">说明：「Agent执行耗时」为 Agent 改造代码阶段；「用例执行耗时」为 ohosTest 设备测试阶段；「总耗时」≈「Agent执行耗时」+「用例执行耗时」（相差不超过 1 秒为时间取整）；「交互(模型/工具)」为模型调用次数 / 工具调用次数。</p>`;

  const exportScript = `<script>
  function exportCases() {
    var table = document.querySelector('.tbl-wrap table');
    if (!table) return;
    var rows = [];
    table.querySelectorAll('tr').forEach(function (tr) {
      var cells = Array.from(tr.querySelectorAll('th, td'));
      if (!cells.length) return;
      cells.pop();
      rows.push(cells.map(function (c) { return c.textContent.trim(); }));
    });
    if (!rows.length) return;
    var lastCol = rows[0].length;
    var maxNameLen = 0;
    for (var ri0 = 1; ri0 < rows.length; ri0++) { if (rows[ri0][0] && rows[ri0][0].length > maxNameLen) maxNameLen = rows[ri0][0].length; }
    var nameWidth = maxNameLen + 10;
    function ex(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    var sheetRows = '';
    rows.forEach(function (row, ri) {
      sheetRows += '<row>' + row.map(function (v, ci) {
        var s = ri === 0 ? '1' : (ci === 0 ? '3' : '2');
        return '<c s="' + s + '" t="inlineStr"><is><t xml:space="preserve">' + ex(v) + '</t></is></c>';
      }).join('') + '</row>';
    });
    var ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';
    var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
    var wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="\\u7528\\u4f8b\\u6267\\u884c\\u4e00\\u89c8" sheetId="1" r:id="rId1"/></sheets></workbook>';
    var wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
    var styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2E75B6"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    var colsXml = '<cols><col min="1" max="1" width="' + nameWidth + '" customWidth="1"/><col min="2" max="3" width="25" customWidth="1"/>';
    if (lastCol > 4) colsXml += '<col min="4" max="' + (lastCol - 1) + '" width="15" customWidth="1"/>';
    colsXml += '<col min="' + lastCol + '" max="' + lastCol + '" width="25" customWidth="1"/></cols>';
    var sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + colsXml + '<sheetData>' + sheetRows + '</sheetData></worksheet>';
    var files = [
      { name: '[Content_Types].xml', data: ct },
      { name: '_rels/.rels', data: rels },
      { name: 'xl/workbook.xml', data: wb },
      { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
      { name: 'xl/styles.xml', data: styles },
      { name: 'xl/worksheets/sheet1.xml', data: sheet }
    ];
    var crcTable = [];
    for (var i = 0; i < 256; i++) { var c = i; for (var j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); crcTable[i] = c; }
    function crc32(buf) { var c = 0xFFFFFFFF; for (var i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
    var enc = new TextEncoder();
    var local = [], central = [], offset = 0;
    files.forEach(function (f) {
      var nameB = enc.encode(f.name), data = enc.encode(f.data), crc = crc32(data), sz = data.length;
      var lh = new Uint8Array(30 + nameB.length), dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint32(14, crc, true); dv.setUint32(18, sz, true); dv.setUint32(22, sz, true); dv.setUint16(26, nameB.length, true); lh.set(nameB, 30);
      local.push(lh, data);
      var ch = new Uint8Array(46 + nameB.length); dv = new DataView(ch.buffer);
      dv.setUint32(0, 0x02014b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 20, true); dv.setUint16(10, 0, true); dv.setUint32(16, crc, true); dv.setUint32(20, sz, true); dv.setUint32(24, sz, true); dv.setUint16(28, nameB.length, true); dv.setUint32(42, offset, true); ch.set(nameB, 46);
      central.push(ch);
      offset += lh.length + sz;
    });
    var localSize = local.reduce(function (s, p) { return s + p.length; }, 0);
    var centralSize = central.reduce(function (s, p) { return s + p.length; }, 0);
    var eocd = new Uint8Array(22), dv = new DataView(eocd.buffer);
    dv.setUint32(0, 0x06054b50, true); dv.setUint16(8, files.length, true); dv.setUint16(10, files.length, true); dv.setUint32(12, centralSize, true); dv.setUint32(16, localSize, true);
    var all = local.concat(central, [eocd]), total = all.reduce(function (s, p) { return s + p.length; }, 0);
    var zip = new Uint8Array(total), pos = 0;
    all.forEach(function (p) { zip.set(p, pos); pos += p.length; });
    var blob = new Blob([zip], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '用例执行一览_${batch.batchId || ""}.xlsx';
    a.click();
    URL.revokeObjectURL(a.href);
  }
  </script>`;

  const whiteboxSection = buildWhiteboxSection(whitebox);
  const cloudSection = buildCloudTestSection(cloudTest);

  return pageShell({
    title: `批次总览 · ${batch.batchId || ""}`,
    body: head + table + whiteboxSection + cloudSection,
    extraHead: exportScript,
  });
}

// ============ 详情页 ============

function buildCasePage({ caseName, caseResult, agentMetrics, runnerResult, testRows, executionInfo, failureAnalysis }) {
  const r = caseResult || {};
  const am = agentMetrics || {};
  const agentType = text(r.agent || executionInfo?.agent);
  const providerId = text(r.providerId || executionInfo?.providerId);
  const modelId = text(r.modelId || executionInfo?.modelId);
  const model = [providerId, modelId].filter(Boolean).join("/");
  const overview = summarizeTestRows(testRows);
  const compile = am.compile || r.agentCompile || {};
  const compileAttempts = num(compile.attempts);

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
        <div class="row"><span class="k">模型/工具调用</span><span>${am.modelCalls ?? "--"} / ${am.toolCalls ?? "--"}</span></div>
        <div class="row"><span class="k">输入 Token</span><span>${fmtToken(r.tokenUsage?.input)}</span></div>
        <div class="row"><span class="k">输出 Token</span><span>${fmtToken(r.tokenUsage?.output)}</span></div>
        <div class="row"><span class="k">推理 Token</span><span>${fmtToken(r.tokenUsage?.reasoning)}</span></div>
        <div class="row"><span class="k">缓存读取</span><span>${fmtToken(r.tokenUsage?.cacheRead)}</span></div>
        <div class="row"><span class="k">合计 Token</span><span title="合计 = 输入 + 输出 + 推理 + 缓存读取 + 缓存写入"><b>${fmtToken(r.tokenUsage?.total)}</b></span></div>
        ${r.agentError ? `<div class="row" style="grid-column:1/-1"><span class="k">Agent 错误</span><span class="error">${esc(r.agentError)}</span></div>` : ""}
      </div>
    </div>`;

  const compileCard = `
    <h2>Agent 编译</h2>
    <div class="card compile-card">
      <div class="compile-total">
        <div class="k">编译尝试次数</div>
        <div class="v">${compileAttempts}</div>
      </div>
      <div class="compile-breakdown">
        <div class="compile-item"><div class="k">成功</div><div class="v pass">${num(compile.succeeded)}</div></div>
        <div class="compile-item"><div class="k">失败</div><div class="v fail">${num(compile.failed)}</div></div>
        <div class="compile-item"><div class="k">中断</div><div class="v muted">${num(compile.interrupted)}</div></div>
        <div class="compile-item"><div class="k">运行中</div><div class="v">${num(compile.running)}</div></div>
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
  const analysisById = new Map(
    (failureAnalysis?.analyses || []).map((item) => [item.failureId, item]),
  );
  // 兼容分析协议或 failureId 算法升级：分析文件同时保存了原始失败项，
  // 可按设备/测试类/测试名重新建立当前报告使用的 ID 映射。
  for (const failure of failureAnalysis?.failures || []) {
    const analysis = analysisById.get(failure.failureId);
    if (analysis) analysisById.set(failureIdentity(failure), analysis);
  }
  const categoryLabels = {
    interaction_failure: "交互定位失败",
    implementation_defect: "实现缺陷",
    test_defect: "测试缺陷",
    environment: "环境问题",
    inconclusive: "证据不足",
  };
  const confidenceLabels = { high: "高", medium: "中", low: "低" };
  const detailBody = testRows.length
    ? testRows.map((row) => {
        const isFail = row.status === "failed" || row.status === "error";
        const analysis = isFail ? analysisById.get(failureIdentity(row)) : null;
        const reasonId = isFail && (analysis || row.message || row.stack) ? `r${reasonIndex++}` : null;
        if (reasonId) {
          reasons[reasonId] = {
            title: `${row.deviceProfile || row.deviceId} · ${row.name}`,
            message: row.message,
            stack: row.stack,
            analysis: analysis?.interaction?.conclusion || analysis?.summary || "",
            expectedBehavior: analysis?.expectedBehavior || "",
            actualBehavior: analysis?.actualBehavior || "",
            technicalCause: analysis?.technicalCause || "",
            interaction: analysis?.interaction || null,
            categoryLabel: categoryLabels[analysis?.category] || "",
            confidenceLabel: confidenceLabels[analysis?.confidence] || "",
            evidence: analysis?.evidence || [],
            suggestion: analysis?.suggestion || "",
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
  const body = back + head + agentCard + compileCard + overviewTable + detailTable + reasonModalMarkup();
  return pageShell({ title: `${caseName} · 详情`, body, extraHead }) + modalScript();
}

// ============ 主入口 ============

export async function writeHtmlReport({ batchRoot, summary }) {
  const report = await readJson(path.join(batchRoot, "report.json"));
  const uploadResults = await readJson(path.join(batchRoot, "upload-results.json")) || {};
  const results = Array.isArray(summary?.results) ? summary.results : [];
  const representativeResult = results.find((item) => item?.agent || item?.providerId || item?.modelId) || {};
  const executionInfo = {
    agent: text(summary?.agent || report?.agent?.type || representativeResult.agent),
    providerId: text(summary?.providerId || report?.agent?.providerId || representativeResult.providerId),
    modelId: text(summary?.modelId || report?.agent?.modelId || representativeResult.modelId),
    sourceMode: resolveAgentSourceMode({ summary, batchRoot, agent: text(summary?.agent || report?.agent?.type || representativeResult.agent) }),
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
      downloadUrl: uploadResults[caseName]?.url || "",
      testSummary: testRows.length
        ? `<span class="pass">✓ ${ts.passes}</span> / <span class="fail">✗ ${ts.failures}</span> / <span class="error">⊗ ${ts.errors}</span>`
        : (result?.ohosTest?.status ? badge(result.ohosTest.status) : "--"),
      // 用例级通过率：通过 / (通过+失败+错误)，百分比取整；无执行结果时 --
      passRate: (() => {
        const denom = ts.passes + ts.failures + ts.errors;
        return denom > 0 ? `${Math.round((ts.passes / denom) * 100)}%` : "--";
      })(),
    });
  }

  // 白盒评价 / 云测试章节数据：相对链接基于批次根目录（overview.html 所在目录）。
  // 阶段开关按 summary/report 记录判定：明确关闭时整节省略（忽略残留数据），
  // 开启但无数据时渲染空态章节，历史批次无标记但有数据仍展示
  const whiteboxFlag = report?.whitebox?.enabled ?? summary?.whiteboxEvaluation?.enabled;
  const cloudFlag = summary?.cloudTest?.enabled;
  const whiteboxRows = collectWhiteboxRows(results, batchRoot, { enabled: whiteboxFlag });
  const cloud = await collectCloudTestRows(results, batchRoot, { enabled: cloudFlag });

  // 写 overview.html
  const overviewHtml = buildOverview({
    summary,
    report,
    caseRows,
    executionInfo,
    whitebox: {
      rows: whiteboxRows,
      showWhenEmpty: whiteboxFlag === true,
    },
    cloudTest: {
      rows: cloud.rows,
      totals: cloud.totals,
      showWhenEmpty: cloudFlag === true,
    },
  });
  await fs.writeFile(path.join(batchRoot, "overview.html"), overviewHtml, "utf8");

  // 写 subpage/<case>.html
  const subpageDir = path.join(batchRoot, "subpage");
  await fs.mkdir(subpageDir, { recursive: true });
  const written = [];
  for (const result of results) {
    const caseName = text(result.case);
    const am = agentByCase.get(caseName) || {};
    const runnerResult = await readJson(result?.ohosTest?.resultPath || "");
    const inferredAnalysisPath = result?.resultPath
      ? path.join(path.dirname(result.resultPath), "failure-analysis", "failure-analysis.json")
      : path.join(batchRoot, caseName, "failure-analysis", "failure-analysis.json");
    const failureAnalysis = await readJson(result?.ohosTest?.failureAnalysis?.resultPath || "")
      || await readJson(inferredAnalysisPath);
    const testRows = flattenRunnerTests(runnerResult);
    const html = buildCasePage({
      caseName,
      caseResult: { ...result },
      agentMetrics: am,
      runnerResult,
      testRows,
      executionInfo,
      failureAnalysis,
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

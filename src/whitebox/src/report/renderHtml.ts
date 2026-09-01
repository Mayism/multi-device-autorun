import fs from "node:fs/promises";
import path from "node:path";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function badge(value: unknown): string {
  const text = String(value ?? "--");
  const kind = /满足|pass|completed|none/i.test(text)
    ? "ok"
    : /不满足|fail|high|error/i.test(text)
      ? "bad"
      : "warn";
  return `<span class="badge ${kind}">${esc(text)}</span>`;
}

function renderDimensions(result: JsonRecord): string {
  const rows = array(result.dimension_results).map((item) => {
    const dimension = record(item);
    return `<tr><td>${esc(dimension.dimension_name)}</td><td class="num">${esc(dimension.score)} / ${esc(dimension.max_score)}</td><td>${esc(dimension.comment)}</td></tr>`;
  });
  return rows.length
    ? rows.join("")
    : '<tr><td colspan="3" class="muted">暂无维度评分</td></tr>';
}

function renderRules(result: JsonRecord): string {
  const rows = array(result.rule_audit_results).map((item) => {
    const rule = record(item);
    return `<tr><td>${esc(rule.rule_id)}</td><td>${badge(rule.result)}</td><td>${esc(rule.rule_summary)}</td><td>${esc(rule.conclusion)}</td></tr>`;
  });
  return rows.length
    ? rows.join("")
    : '<tr><td colspan="4" class="muted">没有规则审计结果</td></tr>';
}

function renderRisks(result: JsonRecord): string {
  const items = array(result.risks).map((item) => {
    const risk = record(item);
    return `<li><div>${badge(risk.level)} <b>${esc(risk.title ?? risk.risk_code)}</b></div><div class="muted">${esc(risk.description ?? risk.evidence ?? "")}</div></li>`;
  });
  return items.length ? `<ul>${items.join("")}</ul>` : '<p class="muted">未发现风险</p>';
}

export function renderWhiteboxHtml(result: JsonRecord): string {
  const overall = record(result.overall_conclusion);
  const basic = record(result.basic_info);
  const totalScore = overall.total_score ?? 0;
  const hardGate = overall.hard_gate_triggered === true;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>白盒评价报告</title><style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:#f4f6fa;color:#1f2937}.wrap{max-width:1180px;margin:auto;padding:28px}.hero,.card{background:white;border:1px solid #e5e7eb;border-radius:12px;padding:20px;margin-bottom:18px}.hero{display:flex;justify-content:space-between;align-items:center}.score{font-size:44px;font-weight:750;color:#155eef}.muted{color:#667085}.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px}.ok{background:#dcfae6;color:#067647}.bad{background:#fee4e2;color:#b42318}.warn{background:#fef0c7;color:#b54708}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #eaecf0;text-align:left;vertical-align:top}th{background:#f9fafb}.num{text-align:right}li{margin:10px 0}h1,h2{margin-top:0}</style></head>
<body><main class="wrap"><section class="hero"><div><h1>白盒评价报告</h1><div class="muted">${esc(basic.target_description ?? "HarmonyOS 生成工程评分")}</div></div><div><div class="score">${esc(totalScore)}</div><div>${hardGate ? badge("已触发硬门槛") : badge("未触发硬门槛")}</div></div></section>
<section class="card"><h2>总体结论</h2><p>${esc(overall.summary)}</p><div class="muted">任务类型：${esc(basic.task_type)} · 评价模式：${esc(basic.evaluation_mode)}</div></section>
<section class="card"><h2>维度评分</h2><table><thead><tr><th>维度</th><th class="num">得分</th><th>评价</th></tr></thead><tbody>${renderDimensions(result)}</tbody></table></section>
<section class="card"><h2>主要问题</h2><ul>${array(result.main_issues).map((item) => `<li>${esc(typeof item === "string" ? item : JSON.stringify(item))}</li>`).join("") || '<li class="muted">暂无</li>'}</ul></section>
<section class="card"><h2>风险</h2>${renderRisks(result)}</section>
<section class="card"><h2>规则审计</h2><table><thead><tr><th>规则</th><th>结论</th><th>摘要</th><th>依据</th></tr></thead><tbody>${renderRules(result)}</tbody></table></section>
</main></body></html>`;
}

export async function writeWhiteboxHtml(result: JsonRecord, outputPath: string): Promise<string> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, renderWhiteboxHtml(result), "utf-8");
  return outputPath;
}

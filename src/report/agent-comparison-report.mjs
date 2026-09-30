import fs from "node:fs/promises";
import path from "node:path";
import { runPythonWorker } from "../runtime/python-worker.mjs";
import { badge, esc, fmtDuration, pageShell } from "./html-report.mjs";

function targetCards(targets) {
  return `<h2>Agent 执行概览</h2><div class="stats">${targets.map((target) => `
    <div class="stat">
      <div class="k">${esc(target.label)}</div>
      <div class="v">${badge(target.status)}</div>
      <div class="muted">${esc(target.agent || "--")} · ${esc(target.providerId && target.modelId ? `${target.providerId}/${target.modelId}` : "--")}</div>
      <div class="muted">完成 ${target.summary.completed}/${target.summary.total} · UI ${target.summary.passRate} · Token ${target.summary.tokenTotal}</div>
      ${target.error ? `<div class="fail">${esc(target.error)}</div>` : `<a class="link" href="${esc(target.overviewHref)}">查看 Agent 报告</a>`}
    </div>`).join("")}</div>`;
}

function comparisonTable(targets) {
  const caseNames = [...new Set(targets.flatMap((target) => Object.keys(target.cases)))].sort();
  const headers = targets.map((target) => `<th>${esc(target.label)}</th>`).join("");
  const rows = caseNames.map((caseName) => `<tr><td style="text-align:left">${esc(caseName)}</td>${targets.map((target) => {
    const item = target.cases[caseName];
    if (!item) return '<td class="empty">--</td>';
    return `<td>
      <a class="link" href="${esc(item.detailHref)}">${badge(item.status)}</a>
      <div class="muted">UI ${esc(item.tests.passRate)} · 白盒 ${item.whiteboxScore ?? "--"}</div>
      <div class="muted">${fmtDuration(item.elapsedSec)} · Token ${item.tokenTotal}</div>
    </td>`;
  }).join("")}</tr>`).join("");
  return `<h2>${targets.length > 1 ? "用例横向对比" : "用例执行一览"}</h2>
    <div class="card tbl-wrap"><table><thead><tr><th>用例</th>${headers}</tr></thead>
    <tbody>${rows || `<tr><td colspan="${targets.length + 1}" class="empty">暂无用例数据</td></tr>`}</tbody></table></div>`;
}

export async function writeAgentComparisonReport({ runRoot, runId, generationModel, targets }) {
  const comparison = JSON.parse((await runPythonWorker("comparison-report", {
    runRoot, runId, generationModel, targets, generatedAt: new Date().toISOString(),
  })).toString("utf8"));
  const loaded = comparison.targets;
  const sameModelValidated = comparison.sameModelValidated;
  let comparisonPath = "";
  if (loaded.length > 1) {
    comparisonPath = path.join(runRoot, "comparison.json");
    await fs.writeFile(comparisonPath, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
  }
  const title = loaded.length > 1 ? "Autorun Agent 对比总览" : "Autorun 批次执行总览";
  const modelText = `${generationModel.providerId || "--"}/${generationModel.modelId || "--"}`;
  const body = `<h1>${title}</h1>
    <h2>运行配置</h2>
    <div class="stats">
      <div class="stat"><div class="k">批次</div><div class="v">${esc(runId)}</div></div>
      <div class="stat"><div class="k">统一模型</div><div class="v">${esc(modelText)}</div></div>
      <div class="stat"><div class="k">Agent 数量</div><div class="v">${loaded.length}</div></div>
      ${loaded.length > 1 ? `<div class="stat"><div class="k">模型一致性</div><div class="v">${sameModelValidated ? '<span class="pass">✓ 已验证</span>' : '<span class="fail">✗ 不一致</span>'}</div></div>` : ""}
    </div>${targetCards(loaded)}${comparisonTable(loaded)}`;
  const overviewPath = path.join(runRoot, "overview.html");
  await fs.writeFile(overviewPath, pageShell({ title: `${title} · ${runId}`, body }), "utf8");
  return { overviewPath, comparisonPath, comparison };
}

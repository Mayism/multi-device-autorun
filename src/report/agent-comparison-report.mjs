import fs from "node:fs/promises";
import path from "node:path";
import { badge, esc, fmtDuration, pageShell } from "./html-report.mjs";

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function percent(passes, failures, errors) {
  const total = number(passes) + number(failures) + number(errors);
  return total ? `${Math.round((number(passes) / total) * 100)}%` : "--";
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function loadTarget(runRoot, target) {
  const targetRoot = target.targetRoot || path.join(runRoot, target.id);
  const summary = target.summary || await readJson(path.join(targetRoot, "summary.json"));
  const report = target.report || await readJson(path.join(targetRoot, "report.json"));
  const environment = summary?.environment || target.environment
    || await readJson(path.join(targetRoot, "environment.json"));
  const error = String(target.error || "");
  const agentCases = new Map((report?.agent?.cases || []).map((item) => [String(item.case), item]));
  const testCases = new Map((report?.ohosTest?.caseResults || []).map((item) => [String(item.case), item]));
  const whiteboxCases = new Map((report?.whitebox?.cases || []).map((item) => [String(item.case), item]));
  const resultCases = new Map((summary?.results || []).map((item) => [String(item.case), item]));
  const caseNames = new Set([...agentCases.keys(), ...testCases.keys(), ...whiteboxCases.keys(), ...resultCases.keys()]);
  const cases = {};
  for (const caseName of caseNames) {
    const agent = agentCases.get(caseName) || {};
    const test = testCases.get(caseName) || {};
    const whitebox = whiteboxCases.get(caseName) || {};
    const result = resultCases.get(caseName) || {};
    const run = test.run || {};
    const deviceTotals = (run.devices || []).reduce((totals, device) => {
      totals.passes += number(device.passes);
      totals.failures += number(device.failures);
      totals.errors += number(device.errors);
      return totals;
    }, { passes: 0, failures: 0, errors: 0 });
    cases[caseName] = {
      status: String(result.status || agent.status || test.status || "unknown"),
      elapsedSec: number(result.elapsedSec || agent.elapsedSec),
      tokenTotal: number(result?.tokenUsage?.total || agent?.tokenUsage?.total),
      modelCalls: number(agent.modelCalls),
      toolCalls: number(agent.toolCalls),
      tests: {
        status: String(test.status || ""),
        ...deviceTotals,
        passRate: percent(deviceTotals.passes, deviceTotals.failures, deviceTotals.errors),
      },
      whiteboxScore: Number.isFinite(Number(whitebox.totalScore)) ? Number(whitebox.totalScore) : null,
      detailHref: `${encodeURIComponent(target.id)}/subpage/${encodeURIComponent(`${caseName}.html`)}`,
    };
  }
  return {
    id: target.id,
    label: target.label || target.id,
    mode: target.mode || summary?.opencodeSourceMode || "",
    agent: summary?.agent || report?.agent?.type || target.agent || "",
    status: error ? "failed" : (summary?.status || "failed"),
    error,
    providerId: summary?.providerId || report?.agent?.providerId || environment?.generationModel?.providerId || "",
    modelId: summary?.modelId || report?.agent?.modelId || environment?.generationModel?.modelId || "",
    modelConfigFingerprint: environment?.generationModel?.configFingerprint || "",
    summary: {
      total: number(summary?.total),
      completed: number(summary?.completed),
      failed: number(summary?.failed),
      tokenTotal: number(summary?.tokenUsage?.total || report?.agent?.totalTokens),
      modelCalls: number(report?.agent?.modelCalls),
      toolCalls: number(report?.agent?.toolCalls),
      testsRun: number(report?.ohosTest?.testsRun),
      passes: number(report?.ohosTest?.passes),
      failures: number(report?.ohosTest?.failures),
      errors: number(report?.ohosTest?.errors),
      passRate: percent(report?.ohosTest?.passes, report?.ohosTest?.failures, report?.ohosTest?.errors),
      whiteboxAverageScore: Number.isFinite(Number(report?.whitebox?.averageScore)) ? Number(report.whitebox.averageScore) : null,
    },
    overviewHref: `${encodeURIComponent(target.id)}/overview.html`,
    cases,
  };
}

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
  const loaded = [];
  for (const target of targets) loaded.push(await loadTarget(runRoot, target));
  const modelFingerprints = [...new Set(loaded.map((target) => target.modelConfigFingerprint).filter(Boolean))];
  const sameModelValidated = loaded.every((target) =>
    target.providerId === generationModel.providerId && target.modelId === generationModel.modelId)
    && modelFingerprints.length <= 1;
  const comparison = {
    schemaVersion: "autorun-agent-comparison-v1",
    runId,
    generatedAt: new Date().toISOString(),
    generationModel,
    sameModelValidated,
    targetCount: loaded.length,
    targets: loaded,
  };
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

// cloudtest-report.mjs
// 云测试任务结果报告：拉取 AGC 报告接口数据并生成自包含的 cloudtest-report.html。
// 数据源（相对 apptest 前缀）：
//   task/report/developer/apps/{id}     任务组元信息 + 应用信息 + 设备列表
//   report/report/overview/result       规则通过/失败计数、设备完成度
//   report/report/overview/problem      问题明细（规则号/描述/规范链接/出错位置）
//   report/report/task/list             设备×用例明细矩阵（PASS/FAIL/NO_VALUE）
//   report/devReportTitle/list/{id}/{c} 表头配置（用例 prop → 中文列名与分组）
// 页面骨架与样式复用 html-report.mjs 的 pageShell/badge 体系，离线可打开。

import fsp from "node:fs/promises";
import path from "node:path";
import { pageShell, esc, badge, fmtDateTime, fmtDuration } from "./html-report.mjs";

/**
 * 拉取任务报告数据。各接口独立容错（失败置 null 并记录 errors），不互相阻断。
 * @returns {Promise<{apps: object[]|null, overview: object|null, problems: object[]|null,
 *   taskList: object[]|null, titles: object[]|null, errors: string[]}>}
 */
export async function fetchTaskReport(client, { taskGroupId, category }) {
  const errors = [];
  const safe = async (label, fn) => {
    try {
      return await fn();
    } catch (error) {
      errors.push(`${label}: ${error.message}`);
      return null;
    }
  };
  const [apps, overview, problems, taskList, titles] = await Promise.all([
    safe("任务元信息", () => client.getReportApps(taskGroupId)),
    safe("总览结果", () => client.getOverviewResult(taskGroupId)),
    safe("问题明细", () => client.getOverviewProblem(taskGroupId, category)),
    safe("设备用例矩阵", () => client.getReportTaskList(taskGroupId, category)),
    safe("表头配置", () => client.getDevReportTitle(taskGroupId, category)),
  ]);
  return { apps, overview, problems, taskList, titles, errors };
}

/**
 * 把 fetchTaskReport 结果压缩为可持久化的结构化摘要（规则/设备/问题计数）。
 * 编排器将其写入 cloudtest-result.json 的 report.summary，供批次报表与跨批次
 * 合并在数据层汇总（不再解析 HTML）。
 * @param {object} report - fetchTaskReport 返回值
 * @returns {{deviceCount: number, devicePassed: number, deviceFailed: number,
 *   rulePassed: number, ruleFailed: number, issueCount: number}}
 */
export function summarizeTaskReport(report) {
  const taskList = Array.isArray(report?.taskList) ? report.taskList : [];
  const ruleInfo = report?.overview?.categoryResults?.[0]?.ruleInfo || {};
  return {
    deviceCount: taskList.length,
    devicePassed: taskList.filter((t) => Number(t?.resultStatus) === 1).length,
    deviceFailed: taskList.filter((t) => Number(t?.resultStatus) === 2).length,
    rulePassed: Number(ruleInfo.passedErrorCount) || 0,
    ruleFailed: Number(ruleInfo.failedErrorCount) || 0,
    issueCount: Array.isArray(report?.problems) ? report.problems.length : 0,
  };
}

function resultCell(item) {
  if (!item) return '<span class="badge badge-muted">-</span>';
  const value = String(item.resultStatus || "").toUpperCase();
  const rules = String(item.ruleNums || "").trim();
  if (value === "PASS") return '<span class="badge badge-ok">PASS</span>';
  if (value === "FAIL") {
    return rules
      ? `<span class="badge badge-error" title="未通过规则: ${esc(rules)}">FAIL</span>`
      : '<span class="badge badge-error">FAIL</span>';
  }
  return '<span class="badge badge-muted">NO_VALUE</span>';
}

function statCard(label, valueHtml) {
  return `<div class="stat"><div class="k">${esc(label)}</div><div class="v">${valueHtml}</div></div>`;
}

function kvCard(title, rows, { inline = false } = {}) {
  const items = rows
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value, wide]) => `<div class="row${wide ? " wide" : ""}"><span class="k">${esc(key)}</span><span>${value}</span></div>`)
    .join("");
  if (!items) return "";
  return `
    <h2>${esc(title)}</h2>
    <div class="card cloudtest-kv${inline ? " kv-inline" : ""}" style="padding:16px 18px;">
      <div class="kv">${items}</div>
    </div>`;
}

/** 设备×用例矩阵：行=设备，列=按表头配置分组的用例。 */
function matrixCard(taskList, titles) {
  if (!Array.isArray(taskList) || !taskList.length) return "";
  // 列定义：优先取表头配置的分组顺序，兜底用设备结果里出现的用例
  const columns = [];
  const seen = new Set();
  if (Array.isArray(titles)) {
    for (const group of titles) {
      for (const child of group?.children || []) {
        const prop = child?.prop;
        if (prop && !seen.has(prop) && !["device", "operation"].includes(child?.slot)) {
          seen.add(prop);
          columns.push({ group: group?.label || "", label: child?.label || prop, prop });
        }
      }
    }
  }
  for (const task of taskList) {
    for (const item of task.useCaseResultList || []) {
      if (item?.useCase && !seen.has(item.useCase)) {
        seen.add(item.useCase);
        columns.push({ group: "", label: item.useCase, prop: item.useCase });
      }
    }
  }
  if (!columns.length) return "";

  // 标记每个分组的起始列（第 0 列除外），用于渲染组间竖向分隔线
  columns.forEach((column, index) => {
    column.groupStart = index > 0 && column.group !== columns[index - 1].group;
  });
  const grouped = [];
  for (const column of columns) {
    const last = grouped[grouped.length - 1];
    if (last && last.group === column.group) last.children.push(column);
    else grouped.push({ group: column.group, children: [column] });
  }
  const headRow1 = ['<th rowspan="2" style="text-align:left">设备</th>']
    .concat(grouped.map((group) => {
      const startClass = group.children[0].groupStart ? " group-start" : "";
      return `<th colspan="${group.children.length}" class="matrix-group${startClass}" style="text-align:center">${esc(group.group || "用例")}</th>`;
    }))
    .join("");
  const headRow2 = grouped.flatMap((group) => group.children.map((child) => `<th class="matrix-col${child.groupStart ? " group-start" : ""}">${esc(child.label)}</th>`)).join("");

  const rows = taskList.map((task) => {
    const device = task.deviceInfo || {};
    const byUseCase = new Map((task.useCaseResultList || []).map((item) => [item?.useCase, item]));
    const cells = columns
      .map((column) => `<td class="matrix-cell${column.groupStart ? " group-start" : ""}">${resultCell(byUseCase.get(column.prop))}</td>`)
      .join("");
    return `<tr><td class="device-cell">${esc(device.displayName || device.typeAlias || device.model || "?")}</td>${cells}</tr>`;
  }).join("");

  return `
    <h2>设备 × 用例结果矩阵</h2>
    <div class="card tbl-wrap matrix-scroll">
      <table class="matrix-table">
        <thead><tr>${headRow1}</tr><tr>${headRow2}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="legend">FAIL 徽标悬浮可查看未通过的规范条款号；NO_VALUE 表示该用例在本设备未产生结果。</p>`;
}

/** 问题明细列表。 */
function problemsCard(problems) {
  if (!Array.isArray(problems) || !problems.length) {
    return `
    <h2>问题明细</h2>
    <div class="card"><div class="empty">无问题记录（或接口未返回数据）</div></div>`;
  }
  const rows = problems.map((problem) => {
    const devices = (problem.errorTask || [])
      .map((error) => {
        const device = error?.deviceInfo?.displayName || error?.deviceInfo?.typeAlias || error?.deviceInfo?.model || "?";
        const positions = Array.isArray(error?.errorPositions) && error.errorPositions.length
          ? `（位置 ${error.errorPositions.join(",")}）`
          : "";
        return `${esc(device)}${positions}`;
      })
      .join("；");
    const ruleLink = problem.ruleUrl
      ? `<a class="link" href="${esc(problem.ruleUrl)}" target="_blank" rel="noopener">${esc(problem.ruleNumber || "查看")}</a>`
      : esc(problem.ruleNumber || "-");
    return `<tr>
      <td>${esc(problem.useCaseCn || problem.useCase || "-")}</td>
      <td>${ruleLink}</td>
      <td class="desc-cell">${esc(problem.ruleDesc || "")}</td>
      <td class="num">${Number(problem.count) || 0}</td>
      <td>${esc(problem.ruleLevel ?? "-")}</td>
      <td class="desc-cell">${devices}</td>
    </tr>`;
  }).join("");
  return `
    <h2>问题明细（${problems.length} 条）</h2>
    <div class="card tbl-wrap">
      <table>
        <thead><tr><th>用例</th><th>规则号</th><th class="desc-cell">规则描述</th><th>次数</th><th>等级</th><th class="desc-cell">出错设备/位置</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/** 设备明细表。 */
function devicesCard(taskList) {
  if (!Array.isArray(taskList) || !taskList.length) return "";
  const rows = taskList.map((task) => {
    const device = task.deviceInfo || {};
    const executed = Number(task.executedStatus);
    const executedLabel = executed === 3 ? "已完成" : executed === 2 ? "执行中" : executed === 1 ? "待执行" : String(task.executedStatus ?? "-");
    const resultLabel = Number(task.resultStatus) === 2 ? "失败" : Number(task.resultStatus) === 1 ? "通过" : String(task.resultStatus ?? "-");
    return `<tr>
      <td>${esc(device.displayName || device.typeAlias || device.model || "?")}</td>
      <td>${esc(device.model || "-")}</td>
      <td>${esc(device.osVersion || device.harmonyVersion || "-")}</td>
      <td>${esc(device.openHarmonySdk ? `API ${device.openHarmonySdk}` : "-")}</td>
      <td>${esc(device.resolution || "-")}</td>
      <td class="num">${task.timeSpan != null ? `${task.timeSpan}` : "-"}</td>
      <td>${esc(executedLabel)}</td>
      <td>${resultLabel === "失败" ? '<span class="badge badge-error">失败</span>' : resultLabel === "通过" ? '<span class="badge badge-ok">通过</span>' : esc(resultLabel)}</td>
      <td class="desc-cell">${esc(task.sysErrorMessageCn || task.connectMessageCn || "")}</td>
    </tr>`;
  }).join("");
  return `
    <h2>设备执行明细</h2>
    <div class="card tbl-wrap">
      <table>
        <thead><tr><th>设备</th><th>型号</th><th>系统版本</th><th>API</th><th>分辨率</th><th>用时</th><th>执行状态</th><th>结果</th><th class="desc-cell">错误信息</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/**
 * 生成云测试 HTML 结果页。
 * @param {object} options
 * @param {object} options.result — cloudtest-result.json 内容（app/build/upload/task/polling 等）
 * @param {object} options.report — fetchTaskReport 返回值
 * @param {string} options.outDir — 输出目录（HTML 与 cloudtest-result.json 平级）
 * @returns {Promise<string>} HTML 文件路径
 */
export async function writeCloudTestHtmlReport({ result, report, outDir }) {
  const app = result?.app || {};
  const build = result?.build || null;
  const upload = result?.upload || {};
  const task = result?.task || {};
  const taskGroup = result?.polling?.taskGroup || {};
  const apps = Array.isArray(report?.apps) ? report.apps[0] || {} : {};
  const appInfo = apps.appInfo || {};
  const ruleInfo = report?.overview?.categoryResults?.[0]?.ruleInfo || {};
  const reportSummary = summarizeTaskReport(report);

  const htmlPath = path.join(outDir, "cloudtest-report.html");
  const body = `
  <div class="wrap">
    <h1>云测试报告 · ${esc(task.taskName || taskGroup.taskGroupName || "未命名任务")}</h1>
    <p class="sub cloudtest-sub">
      任务组 <code>${esc(task.taskGroupId || taskGroup.id || "-")}</code>
      ${badge(result.status || "unknown")}
      <a class="link" href="https://developer.huawei.com/consumer/cn/service/josp/agc/index.html" target="_blank" rel="noopener">AGC 控制台 ↗</a>
      <a class="link" href="cloudtest-result.json">result.json</a>
    </p>

    <h2>结果总览</h2>
    <div class="stats">
      ${statCard("状态", badge(result.status || "unknown"))}
      ${statCard("进度", `${taskGroup.processedTestTaskCount ?? 0}/${taskGroup.taskCount ?? (task.devices?.length || "-")}`)}
      ${statCard("通过规则", String(ruleInfo.passedErrorCount ?? reportSummary.rulePassed ?? "-"))}
      ${statCard("失败规则", String(ruleInfo.failedErrorCount ?? reportSummary.ruleFailed ?? "-"))}
      ${statCard("设备通过/失败", `${reportSummary.devicePassed}/${reportSummary.deviceFailed}`)}
      ${statCard("问题数量", String(reportSummary.issueCount))}
      ${statCard("测试设备", String(report?.taskList?.length ?? taskGroup.deviceCount ?? "-"))}
      ${statCard("云端执行耗时", apps.executeTime ? fmtDuration(Number(apps.executeTime)) : (result.elapsedSec ? fmtDuration(result.elapsedSec) : "-"))}
      ${statCard("免费额度消耗", taskGroup.freeAmount != null ? `${taskGroup.freeAmount} 分钟` : "-")}
      ${statCard("安装包", app.fileSize ? `${(app.fileSize / 1024 / 1024).toFixed(2)} MB` : "-")}
    </div>

    ${kvCard("应用信息", [
      ["应用名称", esc(upload.appName || appInfo.appName || "-")],
      ["版本", esc(upload.appVersion || appInfo.version || app.versionName || "-")],
      ["包名", esc(upload.packageName || appInfo.packageName || app.bundleName || "-")],
      ["应用类型", upload.appType != null ? String(upload.appType) : (appInfo.appType != null ? String(appInfo.appType) : "")],
      ["API 版本", upload.geApiLevel != null ? String(upload.geApiLevel) : (appInfo.geApiLevel != null ? String(appInfo.geApiLevel) : "")],
      ["签名包", esc(app.fileName || "")],
    ])}

    ${kvCard("执行信息", [
      ["任务提交", task.submittedAt ? fmtDateTime(task.submittedAt) : ""],
      ["云端开始", apps.startTime ? fmtDateTime(apps.startTime) : ""],
      ["云端结束", apps.endTime ? fmtDateTime(apps.endTime) : (taskGroup.endTime ? fmtDateTime(new Date(Number(taskGroup.endTime)).toISOString()) : "")],
      ["本流程耗时", result.elapsedSec ? fmtDuration(result.elapsedSec) : ""],
      ["轮询次数", result.polling?.polls != null ? String(result.polling.polls) : ""],
      ...(report?.errors?.length ? [["报告数据缺口", `<span class="muted">${esc(report.errors.join("；"))}</span>`, true]] : []),
    ], { inline: true })}

    ${matrixCard(report?.taskList, report?.titles)}
    ${problemsCard(report?.problems)}
    ${devicesCard(report?.taskList)}
  </div>`;

  const extraCss = `
  .cloudtest-sub { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .cloudtest-sub code { background: var(--accent-soft); padding: 2px 8px; border-radius: 6px; }
  code.hash { font-size: 12px; }
  /* kv 卡片：默认一行两列（应用信息）；kv-inline 单行横排（执行信息，内容短）；
     超长字段（SHA-256/构建命令等）独占整行并允许换行 */
  .cloudtest-kv .kv { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 24px; }
  .cloudtest-kv.kv-inline .kv { display: flex; flex-wrap: wrap; gap: 6px 28px; }
  .cloudtest-kv.kv-inline .kv .row { flex: 0 1 auto; }
  .cloudtest-kv.kv-inline .kv .row .k { flex: 0 0 auto; }
  .cloudtest-kv.kv-inline .kv .row.wide { flex-basis: 100%; }
  .cloudtest-kv .kv .row.wide { grid-column: 1 / -1; }
  .cloudtest-kv .kv .row > span:last-child { white-space: normal; overflow-wrap: anywhere; min-width: 0; }
  .cloudtest-kv .kv .row > span:last-child code.mono { font-size: 12px; }
  .matrix-table { font-size: 12px; }
  .matrix-col { text-align: center; }
  .matrix-cell { text-align: center; }
  .matrix-cell .badge { font-size: 10px; padding: 2px 6px; }
  .device-cell { white-space: nowrap; font-weight: 500; }
  .matrix-scroll { overflow-x: auto; }
  .desc-cell { min-width: 200px; text-align: left; }
  .stat .v { overflow-wrap: anywhere; }
  /* 矩阵分组：分组行底色加深，组间竖线分隔 */
  .matrix-table thead tr:first-child th { background: #edf1f7; border-bottom: 1px solid #d4dbe5; }
  .matrix-table th.matrix-group { font-size: 12px; color: #3a4657; }
  .matrix-table th.group-start, .matrix-table td.group-start { border-left: 2px solid #c6d0dd; }
  .matrix-table tbody td.group-start { border-left: 2px solid #dde3ec; }`;

  const html = pageShell({
    title: `云测试报告 · ${task.taskName || taskGroup.taskGroupName || task.taskGroupId || ""}`,
    body,
    extraHead: `<style>${extraCss}</style>`,
  });
  await fsp.writeFile(htmlPath, html, "utf8");
  return htmlPath;
}

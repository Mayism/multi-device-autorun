// merge-overview.mjs
//
// 合并多个批次目录（扁平 <批次> 或分层 <分层目录名>/<批次>）的执行结果，
// 生成根目录下的一份 overview.html（用例详情直链各批次目录内的 subpage/）。
//
// 用法：import { mergeOverview } from "./src/lib/merge-overview.mjs";
//   await mergeOverview({ root: "output" })
// 入口：node autorun.mjs --merge [output目录]

import fs from "node:fs";
import path from "node:path";
import {
  pageShell,
  esc,
  badge,
  fmtDuration,
  fmtDateTime,
  agentDisplayName,
  resolveAgentSourceMode,
  collectWhiteboxRows,
  collectCloudTestRows,
  buildWhiteboxSection,
  buildCloudTestSection,
} from "./html-report.mjs";
import { buildWhiteboxSummary } from "./batch-report.mjs";

async function readJson(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

function joinDistinct(values) {
  return [...new Set(values.map((v) => String(v ?? "").trim()).filter(Boolean))].join(" / ");
}

function sum(values) {
  return values.reduce((s, v) => s + (Number(v) || 0), 0);
}

// ============ 模块 1：发现批次报告 ============

export function discoverBatches({ root, summaryName = "summary.json" }) {
  const batches = [];
  const collect = (dir, relBase, labelOf) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      if (exists(path.join(dir, d.name, summaryName))) {
        batches.push({
          label: labelOf(d.name),
          dir: path.join(dir, d.name),
          rel: relBase ? `${relBase}/${d.name}` : d.name,
        });
      }
    }
  };
  collect(root, "", (name) => name);
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const nestedRoot = path.join(root, d.name);
    if (exists(path.join(nestedRoot, summaryName))) continue;
    collect(nestedRoot, d.name, (name) => `${d.name}__${name}`);
  }
  batches.sort((a, b) => a.label.localeCompare(b.label));
  const skipped = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((x) => x.isDirectory() && exists(path.join(root, x.name, "overview.html")) && !exists(path.join(root, x.name, summaryName)))
    .map((x) => x.name);
  return { batches, skipped };
}

// ============ 模块 2：清理旧产物 ============

export function cleanOldArtifacts({ root, outputName = "overview.html", outputSubdir = "subpage" }) {
  fs.rmSync(path.join(root, outputName), { force: true });
  fs.rmSync(path.join(root, outputSubdir), { recursive: true, force: true });
}

// ============ 模块 3：读取批次数据 ============

export async function readBatchData(batch) {
  const summary = await readJson(path.join(batch.dir, "summary.json"));
  if (!summary || !Array.isArray(summary.results)) return null;
  const report = await readJson(path.join(batch.dir, "report.json")) || {};
  const uploadResults = await readJson(path.join(batch.dir, "upload-results.json")) || {};
  const results = summary.results;
  const representativeResult = results.find((item) => item?.agent || item?.providerId || item?.modelId) || {};
  const executionInfo = {
    agent: summary.agent || report.agent?.type || representativeResult.agent || "",
    providerId: summary.providerId || report.agent?.providerId || representativeResult.providerId || "",
    modelId: summary.modelId || report.agent?.modelId || representativeResult.modelId || "",
    // Agent 来源分类（自研/软工/裸模），新批次读 summary 记录值，旧批次按分层目录名/Agent 名推断
    sourceMode: resolveAgentSourceMode({ summary, batchRoot: batch.dir, relPath: batch.rel, agent: summary.agent || report.agent?.type || representativeResult.agent || "" }),
  };
  const agentByCase = new Map((report.agent?.cases || []).map((c) => [c.case, c]));
  const caseRows = [];
  for (const result of results) {
    const caseName = String(result.case ?? "");
    const am = agentByCase.get(caseName) || {};
    const runnerResult = await readJson(result?.ohosTest?.resultPath || "");
    const testRows = flattenRunnerTests(runnerResult);
    const ts = summarizeTestRows(testRows);
    const subpageFile = path.join(batch.dir, "subpage", `${caseName}.html`);
    caseRows.push({
      case: caseName,
      detailHref: exists(subpageFile) ? `${batch.rel}/subpage/${encodeURIComponent(`${caseName}.html`)}` : "",
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      elapsedSec: result.elapsedSec,
      agentElapsedSec: result.agentElapsedSec ?? am.elapsedSec,
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
      // 用例级通过率：通过 / (通过+失败+错误)，百分比取整
      passRate: (() => {
        const denom = ts.passes + ts.failures + ts.errors;
        return denom > 0 ? `${Math.round((ts.passes / denom) * 100)}%` : "--";
      })(),
    });
  }
  return { batch, summary, report, results, caseRows, executionInfo };
}

function flattenRunnerTests(runnerResult) {
  if (!runnerResult) return [];
  const devices = runnerResult?.runs?.swe?.devices || [];
  const rows = [];
  for (const device of devices) {
    for (const suite of device.suiteResults || []) {
      for (const tc of suite.testCases || []) {
        const statusCode = Number(tc.statusCode);
        const rawStatus = String(tc.status || "").toLowerCase();
        const status = rawStatus === "passed" || statusCode === 0
          ? "passed"
          : rawStatus === "error" || statusCode === -1
            ? "error"
            : "failed";
        rows.push({ status, durationMs: Number(tc.durationMs) || 0 });
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
  return summary;
}

// ============ 模块 4：合并数据（逐模块产出 HTML 片段）============

export async function mergeData({ perBatch, batches, outputRoot }) {
  const merged = mergeBatchData(perBatch);
  const skillSections = await mergeSkillReports({ perBatch, batches, outputRoot });
  // 白盒评价 / 云测试章节：不看批次阶段开关，批次结果里有数据就合并，
  // 没有就跳过（章节由行数据驱动，无数据时整节省略）；
  // 详情/报告链接指向各批次目录内的产物（相对合并 overview.html 所在根目录）
  const allResults = perBatch.flatMap((pb) => pb.results || []);
  const whiteboxSection = buildWhiteboxSection({
    rows: collectWhiteboxRows(allResults, outputRoot),
  });
  const cloud = await collectCloudTestRows(allResults, outputRoot);
  const cloudTestSection = buildCloudTestSection({
    rows: cloud.rows,
    totals: cloud.totals,
  });
  return {
    title: merged.summary.batchId,
    sections: {
      configSection: buildConfigSection(merged),
      statsSection: buildStatsSection(merged),
      caseTableSection: buildCaseTableSection(merged),
      whiteboxSection,
      cloudTestSection,
      skillEvalSection: skillSections.evalSection,
      skillAuditSection: skillSections.auditSection,
    },
    extraHead: exportCasesScript(merged.summary),
  };
}

function mergeBatchData(perBatch) {
  const allCaseRows = [];
  const allResults = [];
  for (const pb of perBatch) {
    for (const row of pb.caseRows) {
      allCaseRows.push(row);
    }
    allResults.push(...pb.results);
  }

  const identity = (field) =>
    joinDistinct(perBatch.map((pb) => pb.summary?.[field] || pb.executionInfo?.[field]));
  // Agent 展示为「名称/（自研｜软工｜裸模）」后去重：各批次 Agent 与分类一致时合并为单值
  const agent = joinDistinct(perBatch.map((pb) =>
    agentDisplayName(pb.summary?.agent || pb.executionInfo?.agent, pb.summary?.opencodeSourceMode || pb.executionInfo?.sourceMode)));
  const agentReports = perBatch.map((pb) => pb.report?.agent || {});
  const ohosReports = perBatch.map((pb) => pb.report?.ohosTest || {});

  const summary = {
    batchId: `${perBatch.length} 个批次合并`,
    agent,
    providerId: identity("providerId"),
    modelId: identity("modelId"),
    total: sum(perBatch.map((pb) => pb.summary?.total ?? pb.caseRows.length)),
    completed: sum(perBatch.map((pb) => pb.summary?.completed ?? 0)),
    failed: sum(perBatch.map((pb) => pb.summary?.failed ?? 0)),
    tokenUsage: { total: sum(perBatch.map((pb) => pb.summary?.tokenUsage?.total ?? 0)) },
  };
  const report = {
    agent: {
      type: joinDistinct(agentReports.map((r) => r.type)),
      providerId: joinDistinct(agentReports.map((r) => r.providerId)),
      modelId: joinDistinct(agentReports.map((r) => r.modelId)),
      modelCalls: sum(agentReports.map((r) => r.modelCalls)),
      toolCalls: sum(agentReports.map((r) => r.toolCalls)),
    },
    ohosTest: {
      testsRun: sum(ohosReports.map((r) => r.testsRun)),
      passes: sum(ohosReports.map((r) => r.passes)),
      failures: sum(ohosReports.map((r) => r.failures)),
      errors: sum(ohosReports.map((r) => r.errors)),
    },
    whitebox: buildWhiteboxSummary(
      allResults,
      perBatch.some((pb) => pb.report?.whitebox?.enabled === true),
    ),
  };
  const executionInfo = {
    agent: summary.agent,
    providerId: summary.providerId,
    modelId: summary.modelId,
  };
  return { summary, report, caseRows: allCaseRows, executionInfo };
}

function fmtToken(value) {
  const n = Number(value) || 0;
  if (!n) return "--";
  const k = n / 1000;
  return k < 10 ? `${k.toFixed(2)}k` : k < 100 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

function buildConfigSection({ summary, executionInfo }) {
  const modelName = [executionInfo?.providerId, executionInfo?.modelId].filter(Boolean).join("/");
  return `
    <h1>Autorun 执行总览</h1>
    <h2>配置总览</h2>
    <div class="stats">
      <div class="stat"><div class="k">Agent</div><div class="v">${esc(executionInfo?.agent || summary?.agent || "--")}</div></div>
      <div class="stat"><div class="k">模型</div><div class="v">${esc(modelName || "--")}</div></div>
    </div>`;
}

function buildStatsSection({ summary, report }) {
  const agentTotals = report?.agent || {};
  const ohosTotals = report?.ohosTest || {};
  const whiteboxTotals = report?.whitebox || {};
  // 通过率：通过 / (通过+失败+错误)，百分比取整
  const passDenom = (ohosTotals.passes ?? 0) + (ohosTotals.failures ?? 0) + (ohosTotals.errors ?? 0);
  const passRate = passDenom > 0 ? `${Math.round(((ohosTotals.passes ?? 0) / passDenom) * 100)}%` : "--";
  const statCards = [
    { k: "用例总数", v: summary.total ?? "--" },
    { k: "完成 / 失败", v: `${summary.completed ?? 0} / ${summary.failed ?? 0}` },
    { k: "总 Token", v: fmtToken(summary.tokenUsage?.total) },
    { k: "模型调用", v: agentTotals.modelCalls ?? "--" },
    { k: "工具调用", v: agentTotals.toolCalls ?? "--" },
    { k: "执行用例个数", v: ohosTotals.testsRun ?? "--" },
    { k: "通过 / 失败 / 错误", v: `<span class="pass">${ohosTotals.passes ?? 0}</span> / <span class="fail">${ohosTotals.failures ?? 0}</span> / <span class="error">${ohosTotals.errors ?? 0}</span>`, html: true },
    { k: "通过率", v: passRate },
    { k: "白盒完成 / 失败", v: `${whiteboxTotals.completed ?? 0} / ${whiteboxTotals.failed ?? 0}` },
    { k: "白盒平均分", v: whiteboxTotals.averageScore ?? "--" },
  ];
  return `
    <h2>结果总览</h2>
    <div class="stats">${statCards.map((s) => `<div class="stat"><div class="k">${esc(s.k)}</div><div class="v">${s.html ? s.v : esc(s.v)}</div></div>`).join("")}</div>`;
}

function buildCaseTableSection({ summary, caseRows }) {
  const rowsHtml = caseRows.map((c) => {
    const nameCell = c.detailHref
      ? `<a class="link" href="${c.detailHref}">${esc(c.case)}</a>`
      : esc(c.case);
    const detailCell = c.detailHref ? `<a class="link" href="${c.detailHref}">查看详情</a>` : "--";
    return `<tr>
      <td style="text-align:left">${nameCell}</td>
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
      <td>${detailCell}${c.downloadUrl ? ` <a class="link" href="${esc(c.downloadUrl)}" target="_blank">下载</a>` : ""}</td>
    </tr>`;
  }).join("");

  return `
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <h2>用例执行一览</h2>
      <button class="btn" onclick="exportCases()" title="导出 Excel" style="padding:6px 10px"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
    </div>
    <div class="card tbl-wrap" id="cases-table">
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
}

function exportCasesScript(batch) {
  return `<script>
  function exportCases() {
    var table = document.querySelector('#cases-table table') || document.querySelector('.tbl-wrap table');
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
}

async function mergeSkillReports({ perBatch, batches, outputRoot }) {
  const sections = { evalSection: "", auditSection: "" };
  let mod;
  try {
    mod = await import("./merge-skill.mjs");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" && /merge-skill\.mjs/.test(error?.message ?? "")) {
      return sections;
    }
    throw error;
  }
  const params = {
    batchDataList: perBatch,
    batchNames: batches.map((b) => b.label),
    outputRoot,
  };
  if (typeof mod.mergeSkillEvalSection === "function") {
    sections.evalSection = (await mod.mergeSkillEvalSection(params)) ?? "";
  }
  if (typeof mod.mergeSkillAuditSection === "function") {
    let result = mod.mergeSkillAuditSection(params);
    if (result && typeof result.then === "function") result = await result;
    sections.auditSection = result ?? "";
  }
  return sections;
}

// ============ 模块 5：生成 HTML ============

export function generateHtml({ root, title, sections, extraHead = "", outputName = "overview.html" }) {
  const order = [
    sections?.configSection,
    sections?.statsSection,
    sections?.caseTableSection,
    sections?.whiteboxSection,
    sections?.cloudTestSection,
    sections?.skillEvalSection,
    sections?.skillAuditSection,
  ];
  const body = order.filter((s) => typeof s === "string" && s.trim()).join("\n");
  const html = pageShell({ title: `批次总览 · ${title || ""}`, body, extraHead });
  const overviewPath = path.join(root, outputName);
  fs.writeFileSync(overviewPath, html, "utf8");
  return overviewPath;
}

// ============ main ============

export async function mergeOverview({ root, outputName = "overview.html", outputSubdir = "subpage" } = {}) {
  const ROOT = path.resolve(root || process.cwd());

  const { batches, skipped } = discoverBatches({ root: ROOT });
  if (skipped.length) {
    console.warn(`⚠️  以下目录缺 summary.json，已跳过：${skipped.join("、")}`);
  }
  if (batches.length === 0) {
    throw new Error(`在 ${ROOT} 下未找到任何包含 summary.json 的结果目录`);
  }
  console.log(`发现 ${batches.length} 个结果目录：${batches.map((b) => b.label).join("、")}`);

  cleanOldArtifacts({ root: ROOT, outputName, outputSubdir });

  const perBatch = [];
  for (const batch of batches) {
    const pb = await readBatchData(batch);
    if (pb) perBatch.push(pb);
  }
  if (perBatch.length === 0) {
    throw new Error(`在 ${ROOT} 下未找到任何可合并的批次（summary.json 均不可用）`);
  }

  const { title, sections, extraHead } = await mergeData({ perBatch, batches, outputRoot: ROOT });
  const overviewPath = generateHtml({ root: ROOT, title, sections, extraHead, outputName });

  return {
    overviewPath,
    batchCount: perBatch.length,
    skillMerged: Boolean(sections.skillEvalSection || sections.skillAuditSection),
  };
}

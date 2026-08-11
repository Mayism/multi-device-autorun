#!/usr/bin/env node
// merge-overview.mjs
//
// 将多个批次目录（如 test1 / test2 / test3 ...）下的 overview.html 与 subpage/
// 合并成根目录下的一份 overview.html 与 subpage/。
//
// 用法：
//   node merge-overview.mjs [根目录]
//   不传根目录则使用当前工作目录 (cwd)。
//
// 设计原则（最大兼容性）：
//   1. 页面骨架（<head>/<title>/<style>、<h1>、<h2>、legend 等）一律从【首个批次】
//      的 overview.html 原样提取，不硬编码文案。生成器改文案/样式时合并产物自动跟随。
//   2. 卡片（<div class="stat">）按 key 分组合并：value 先剥 HTML 标签成纯文本，
//      再尝试数字类合并（纯数字 / 带单位 k/M/G/T / 斜杠型 X/Y 或 X/Y/Z，跨单位
//      自动换算到最高单位）；识别不出则降级为「值 / 值」拼接，信息不丢失。
//   3. 表格：原样拼接每个批次的 <tbody> 行，不假设列结构、不加批次列；仅把行内的
//      subpage/ 引用改写为带批次前缀（防同名文件覆盖）。
//   4. subpage 文件以「批次名__原文件名」前缀写入，避免同名冲突；子页面内的
//      ../overview.html 因层级不变无需改动。
//   5. 防御性解析：缺 thead / tbody / stats / style 等均跳过对应部分并告警，不中断。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const OUT_OVERVIEW = path.join(ROOT, 'overview.html');
const OUT_SUBPAGE = path.join(ROOT, 'subpage');

const read = p => fs.readFileSync(p, 'utf8');
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };

// ---- 单位表（按 factor 升序；需要新单位在此追加）----
// '' = 无单位(factor=1)；大小写不敏感。
const UNIT_TABLE = [
  { sym: '', factor: 1 },
  { sym: 'k', factor: 1e3 },
  { sym: 'M', factor: 1e6 },
  { sym: 'G', factor: 1e9 },
  { sym: 'T', factor: 1e12 },
];
const UNIT_BY_SYM = new Map(UNIT_TABLE.map(u => [u.sym.toLowerCase(), u]));

// 剥 HTML 标签 + 解码常见实体，把 value 统一成纯文本用于数值合并
function stripHtml(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

// 按 factor 对应的单位格式化数值，精度规则贴近源码 fmtToken：
//   带单位(k及以上)：该单位下 <10 → 2 位小数；<100 → 1 位小数；否则取整。
//     例：factor=1e6(单位M), num=107.912 → "108M"；
//         factor=1e6, num=53.956 → "53.96M"
//   无单位(factor=1)：整数保持整数，小数最多 1 位。
//     例：num=10 → "10"；num=862 → "862"
function fmtWithUnit(num, factor) {
  const u = UNIT_TABLE.find(x => x.factor === factor);
  const sym = u ? u.sym : '';
  if (factor === 1) {
    // 无单位：优先整数显示，避免 10.0 这种
    return (Number.isInteger(num) ? String(num) : String(Math.round(num * 10) / 10)) + sym;
  }
  let v;
  if (num < 10) v = (Math.round(num * 100) / 100).toFixed(2);
  else if (num < 100) v = (Math.round(num * 10) / 10).toFixed(1);
  else v = String(Math.round(num));
  return v + sym;
}

// 解析 "12" / "53M" / "1.5G" → { num, factor }；解析不出返回 null
function parseNumberWithUnit(s) {
  const m = String(s).trim().match(/^([\d.]+)\s*([a-zA-Z]?)$/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num)) return null;
  const sym = m[2];
  const u = sym === '' ? UNIT_TABLE[0] : UNIT_BY_SYM.get(sym.toLowerCase());
  if (!u) return null;
  return { num, factor: u.factor };
}

// 若干 "数字+单位" 合并：换算到最高单位求和，返回展示字符串；任一不可解析返回 null
function mergeNumberWithUnits(values) {
  const parsed = values.map(parseNumberWithUnit);
  if (parsed.some(p => p === null)) return null;
  const maxFactor = Math.max(...parsed.map(p => p.factor));
  const sum = parsed.reduce((s, p) => s + (p.num * p.factor) / maxFactor, 0);
  return fmtWithUnit(sum, maxFactor);
}

// 斜杠型 "X / Y" 或 "X / Y / Z"，每段独立数值合并；段数须一致
function mergeSlashGroups(values) {
  const segs = values.map(v => String(v).trim().split(/\s*\/\s*/));
  const n = segs[0].length;
  if (!segs.every(s => s.length === n)) return null;
  const out = [];
  for (let i = 0; i < n; i++) {
    const m = mergeNumberWithUnits(segs.map(s => s[i]));
    if (m === null) return null;
    out.push(m);
  }
  return out.join(' / ');
}

// 卡片合并：剥 HTML → 尝试数字合并 → 失败降级为「值 / 值」
function smartMerge(rawValues) {
  const values = rawValues.map(stripHtml);
  if (values.length === 1) return values[0];
  const trimmed = values.map(v => v.trim());
  if (trimmed.every(v => v.includes('/'))) {
    const r = mergeSlashGroups(trimmed);
    if (r !== null) return r;
  }
  const r = mergeNumberWithUnits(trimmed);
  if (r !== null) return r;
  return values.join(' / '); // 降级：信息不丢
}

// ---- 1. 发现批次目录 ----
const batches = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter(d => d.isDirectory() && exists(path.join(ROOT, d.name, 'overview.html')))
  .map(d => d.name)
  .sort();

if (batches.length === 0) {
  console.error(`❌ 在 ${ROOT} 下未找到任何包含 overview.html 的结果目录`);
  process.exit(1);
}
console.log(`发现 ${batches.length} 个结果目录：${batches.join('、')}`);

// ---- 2. 清理旧产物 ----
fs.rmSync(OUT_OVERVIEW, { force: true });
fs.rmSync(OUT_SUBPAGE, { recursive: true, force: true });
fs.mkdirSync(OUT_SUBPAGE, { recursive: true });

// ---- 3. 从【首个批次】提取页面骨架（head/title/style/h1/h2/legend 原样复用）----
const firstHtml = read(path.join(ROOT, batches[0], 'overview.html'));

// head 整段：从文档开头到 </head>（含 DOCTYPE、meta、title、style），原样复用
const headEnd = firstHtml.indexOf('</head>');
if (headEnd < 0) {
  console.error(`❌ 首批次 ${batches[0]}/overview.html 未找到 </head>，无法提取页面骨架`);
  process.exit(1);
}
const headBlock = firstHtml.slice(0, headEnd + '</head>'.length);

// 提取首个批次 <body> 内 h1 与 stats 容器之间的内容（含 h1），原样复用
// 兼容 <h1 ...>...</h1> 后跟 <div class="stats"> 的结构
const h1Re = /<h1\b[^>]*>[\s\S]*?<\/h1>/;
const h1Match = firstHtml.match(h1Re);
const h1Block = h1Match ? h1Match[0] : '<h1>批次执行总览</h1>';

// 提取 <h2>（用例一览标题）与 legend，原样复用
const h2Re = /<h2\b[^>]*>[\s\S]*?<\/h2>/;
const h2Match = firstHtml.match(h2Re);
const h2Block = h2Match ? h2Match[0] : '<h2>用例执行一览</h2>';
const legendRe = /<p class="legend">[\s\S]*?<\/p>/;
const legendMatch = firstHtml.match(legendRe);
const legendBlock = legendMatch ? legendMatch[0] : '';

// ---- 4. 解析每个批次（卡片 + 表格行 + subpage）----
const statPairRe = /<div class="stat"><div class="k">(.*?)<\/div><div class="v">([\s\S]*?)<\/div><\/div>/g;
const theadRe = /<thead>([\s\S]*?)<\/thead>/;
const tbodyRe = /<tbody>([\s\S]*?)<\/tbody>/;
const rowRe = /<tr>([\s\S]*?)<\/tr>/g;

let baseThead = '';
const statKeyOrder = [];
const allStats = {};   // key -> [rawValue, ...]
const allRows = [];
let copiedFiles = 0;

for (const batch of batches) {
  const html = batch === batches[0] ? firstHtml : read(path.join(ROOT, batch, 'overview.html'));

  // 表头：取首批次；不一致仅告警（列对齐可能错位），缺失则跳过该批表格行
  const thead = html.match(theadRe)?.[1] ?? '';
  let skipRows = false;
  if (!thead) {
    console.warn(`⚠️  目录 ${batch} 未找到 <thead>，跳过该目录的表格行与子页面`);
    skipRows = true;
  } else if (!baseThead) {
    baseThead = thead;
  } else if (thead.replace(/\s+/g, '') !== baseThead.replace(/\s+/g, '')) {
    console.warn(`⚠️  目录 ${batch} 表头与首个目录不一致，行仍会拼接（列对齐可能错位）`);
  }

  // 卡片：按 key 归集原始 value（含 HTML），缺字段的目录自然不参与该 key
  for (const m of html.matchAll(statPairRe)) {
    const k = m[1].trim();
    const v = m[2].trim();
    if (!statKeyOrder.includes(k)) statKeyOrder.push(k);
    (allStats[k] ??= []).push(v);
  }

  if (skipRows) continue;

  // 表格行：原样拼接，仅改写 subpage/ 引用（加批次前缀防同名覆盖）
  const tbodyMatch = html.match(tbodyRe);
  if (tbodyMatch) {
    for (const rm of tbodyMatch[1].matchAll(rowRe)) {
      const inner = rm[1].replace(/\bsubpage\//g, `subpage/${batch}__`);
      allRows.push(`<tr>${inner}</tr>`);
    }
  } else {
    console.warn(`⚠️  目录 ${batch} 未找到 <tbody>，无表格行可合并`);
  }

  // 拷贝 subpage 文件（前缀隔离）
  const subSrc = path.join(ROOT, batch, 'subpage');
  if (exists(subSrc) && fs.statSync(subSrc).isDirectory()) {
    for (const f of fs.readdirSync(subSrc)) {
      const srcFile = path.join(subSrc, f);
      if (!fs.statSync(srcFile).isFile()) continue;
      fs.copyFileSync(srcFile, path.join(OUT_SUBPAGE, `${batch}__${f}`));
      copiedFiles++;
    }
  } else {
    console.warn(`⚠️  目录 ${batch} 没有 subpage/ 目录`);
  }
}

// ---- 5. 合并卡片 ----
const statsHtml = statKeyOrder.map(k =>
  `<div class="stat"><div class="k">${k}</div><div class="v">${smartMerge(allStats[k])}</div></div>`
).join('');

const tbodyHtml = allRows.length
  ? allRows.join('\n      ')
  : '<tr><td class="empty">暂无用例数据</td></tr>';

// ---- 6. 组装输出（骨架来自首批次，仅替换 stats 与 tbody）----
const out = `${headBlock}
<body>
<div class="wrap">
  ${h1Block}
  <div class="stats">${statsHtml}</div>
  ${h2Block}
  <div class="card tbl-wrap">
    <table>
      <thead>${baseThead}</thead>
      <tbody>${tbodyHtml}
      </tbody>
    </table>
  </div>
  ${legendBlock}
</div>
</body>
</html>`;

fs.writeFileSync(OUT_OVERVIEW, out, 'utf8');
console.log(`✅ 已生成 ${OUT_OVERVIEW}`);
console.log(`✅ 已生成 ${OUT_SUBPAGE}/ （${copiedFiles} 个文件）`);

#!/usr/bin/env node
// generate-html-report.mjs
// 对一个已存在的批次目录重新生成 HTML 报告（overview.html + subpage/<case>.html）。
//
// 用法：
//   node src/generate-html-report.mjs <batchDir>
//   node src/generate-html-report.mjs output/20260810_110005_6447a7e1
//   node src/generate-html-report.mjs --batch <batchDir>
//
// 前提：该目录下存在 summary.json（由 Autorun 执行或恢复时写入）。

import fs from "node:fs/promises";
import path from "node:path";
import { writeHtmlReport } from "./reporting/html-report.mjs";

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 ${filePath}: ${error.message}`);
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let batchDir = "";
  for (let i = 0; i < args.length; i += 1) {
    const v = args[i];
    if (v === "-h" || v === "--help") {
      console.log("用法: node src/generate-html-report.mjs <batchDir>");
      console.log("       node src/generate-html-report.mjs --batch <batchDir>");
      process.exit(0);
    } else if (v === "--batch") {
      batchDir = args[++i];
    } else if (!batchDir) {
      batchDir = v;
    } else {
      throw new Error(`多余参数: ${v}`);
    }
  }
  if (!batchDir) throw new Error("缺少批次目录参数，用法: node src/generate-html-report.mjs <batchDir>");
  return { batchDir: path.resolve(batchDir) };
}

const { batchDir } = parseArgs(process.argv);
const summaryPath = path.join(batchDir, "summary.json");
const summary = await readJson(summaryPath);
if (!summary || typeof summary !== "object") {
  throw new Error(`summary.json 不是合法 JSON 对象: ${summaryPath}`);
}

const result = await writeHtmlReport({ batchRoot: batchDir, summary });
console.log(`已生成 HTML 总览: ${result.overviewPath}`);
console.log(`详情页目录: ${result.subpageDir}`);
for (const p of result.casePages) console.log(`  - ${p}`);

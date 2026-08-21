#!/usr/bin/env node
// upload-results.mjs
// 对一个已完成批次的失败用例打包并上传到 AGC 云存储。
// 凭证已硬编码在 uploader.mjs，无需配置。
//
// 用法：
//   node src/upload-results.mjs <batchDir>

import fs from "node:fs/promises";
import path from "node:path";
import { uploadFailedCases } from "./upload/upload-orchestrator.mjs";

async function readJson(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return null; }
}

const batchDir = process.argv[2] ? path.resolve(process.argv[2]) : "";
if (!batchDir) {
  console.error("用法: node src/upload-results.mjs <batchDir>");
  process.exit(1);
}

const summary = await readJson(path.join(batchDir, "summary.json"));
if (!summary?.results?.length) {
  console.log("[upload] summary.json 无用例数据");
  process.exit(0);
}
const report = await readJson(path.join(batchDir, "report.json"));

const results = await uploadFailedCases({
  batchRoot: batchDir,
  summary,
  report,
  onLog: (msg) => console.log(`[upload] ${msg}`),
});

const ok = Object.values(results).filter((r) => r.url).length;
const fail = Object.values(results).filter((r) => r.error && !r.url).length;
console.log(`[upload] 完成: ${ok} 成功, ${fail} 失败`);

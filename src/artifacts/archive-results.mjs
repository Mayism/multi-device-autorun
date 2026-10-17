#!/usr/bin/env node
// 对已有批次重新生成各用例的本地 ZIP。

import fs from "node:fs/promises";
import path from "node:path";
import { archiveCases } from "./archive-cases.mjs";

const batchRoot = process.argv[2] ? path.resolve(process.argv[2]) : "";
if (!batchRoot) {
  console.error("用法: node src/artifacts/archive-results.mjs <batchDir>");
  process.exit(1);
}
let summary;
try {
  summary = JSON.parse(await fs.readFile(path.join(batchRoot, "summary.json"), "utf8"));
} catch {
  summary = null;
}
if (!Array.isArray(summary?.results)) {
  console.error(`[archive] 无法读取批次用例: ${path.join(batchRoot, "summary.json")}`);
  process.exit(1);
}
const archived = await archiveCases({
  batchRoot,
  summary,
  onLog: (message) => console.log(`[archive] ${message}`),
});
console.log(`[archive] 已打包 ${archived.length} 个用例`);

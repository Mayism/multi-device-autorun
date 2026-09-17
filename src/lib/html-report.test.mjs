import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeHtmlReport } from "./html-report.mjs";

test("用例详情页展示 Agent 编译尝试统计", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "html-compile-attempts-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "report.json"), JSON.stringify({
    agent: {
      cases: [{
        case: "CaseA",
        compile: { attempts: 4, succeeded: 1, failed: 2, interrupted: 1, running: 0 },
      }],
    },
  }), "utf8");

  await writeHtmlReport({
    batchRoot: root,
    summary: {
      batchId: "batch-1",
      results: [{ case: "CaseA", status: "completed" }],
    },
  });

  const html = await fs.readFile(path.join(root, "subpage", "CaseA.html"), "utf8");
  assert.match(html, /<h2>Agent 编译<\/h2>/);
  assert.match(html, /编译尝试次数<\/div>\s*<div class="v">4<\/div>/);
  assert.match(html, /成功<\/div><div class="v pass">1<\/div>/);
  assert.match(html, /失败<\/div><div class="v fail">2<\/div>/);
  assert.match(html, /中断<\/div><div class="v muted">1<\/div>/);
  assert.match(html, /运行中<\/div><div class="v">0<\/div>/);
});

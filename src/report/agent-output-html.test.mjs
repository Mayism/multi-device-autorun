import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { normalizeAgentTrace, renderAgentOutputHtml, writeAgentOutputHtml } from "./agent-output-html.mjs";
import { writeHtmlReport } from "./html-report.mjs";

const sessions = [{
  sessionId: "session-1",
  messages: [{
    info: { id: "message-1", role: "assistant", time: { created: 1000 } },
    parts: [
      { type: "text", text: "检查 <script>alert(1)</script>" },
      { type: "reasoning", text: "先检查文件" },
      { type: "tool", tool: "read", callID: "call-1", state: {
        status: "error", input: { filePath: "a.ts" }, output: "unexpected </script><script>alert(2)</script>",
        error: "读取失败", time: { start: 1100, end: 1200 },
      } },
      { type: "patch", hash: "patch-1", files: ["a.ts"] },
      { type: "step-finish" },
    ],
  }],
}];

test("agent trace preserves message, reasoning, tool details and excludes step markers", () => {
  const [session] = normalizeAgentTrace(sessions);
  assert.deepEqual(session.entries.map((entry) => entry.kind), ["text", "reasoning", "tool", "patch"]);
  assert.equal(session.entries[2].callId, "call-1");
  assert.equal(session.entries[2].start, 1100);
  assert.equal(session.entries[2].end, 1200);
  assert.match(session.entries[2].input, /a\.ts/);
  assert.match(session.entries[3].body, /patch-1/);
});

test("standalone HTML embeds log content safely and includes offline controls", () => {
  const html = renderAgentOutputHtml({ sessions, caseName: "Case A", agentStatus: "failed", agentError: "失败 <img src=x>", tokenUsage: { total: 42 } });
  assert.match(html, /<title>Case A · Agent 执行过程<\/title>/);
  assert.match(html, /href="agent-output\.log"/);
  assert.match(html, /href="all-messages\.json"/);
  assert.match(html, /id="search"/);
  assert.match(html, /id="nextError"/);
  assert.match(html, /\\u003cscript\\u003ealert\(1\)\\u003c\/script\\u003e/);
  assert.doesNotMatch(html, /<script>alert\([12]\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x>/);
  const inlineScript = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(inlineScript);
  assert.doesNotThrow(() => new vm.Script(inlineScript));
});

test("report regeneration creates trace HTML and links it from the case page", async (t) => {
  const batchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-html-report-"));
  t.after(() => fs.rm(batchRoot, { recursive: true, force: true }));
  const generateDir = path.join(batchRoot, "Case A", "generate");
  await fs.mkdir(generateDir, { recursive: true });
  const messagesPath = path.join(generateDir, "all-messages.json");
  await fs.writeFile(messagesPath, JSON.stringify(sessions));
  await fs.writeFile(path.join(generateDir, "agent-output.log"), "raw log\n");
  const directPath = await writeAgentOutputHtml({ messagesPath, caseName: "Case A", agentStatus: "completed" });
  assert.equal(directPath, path.join(generateDir, "agent-output.html"));
  await fs.rm(directPath);
  await writeHtmlReport({ batchRoot, summary: {
    batchId: "batch-1", agent: "test-agent", total: 1, completed: 1, failed: 0,
    results: [{ case: "Case A", status: "completed", agentStatus: "completed", logs: { messagesPath } }],
  } });
  const traceHtml = await fs.readFile(directPath, "utf8");
  const caseHtml = await fs.readFile(path.join(batchRoot, "subpage", "Case A.html"), "utf8");
  assert.match(traceHtml, /Session 1/);
  assert.match(caseHtml, /\.\.\/Case%20A\/generate\/agent-output\.html/);
});

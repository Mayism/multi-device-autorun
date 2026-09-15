import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runMonitoredSession } from "./session-monitor.mjs";

const ANALYSIS_SCHEMA_VERSION = "autorun-uitest-failure-analysis-v1";
const ALLOWED_CATEGORIES = new Set([
  "implementation_defect",
  "test_defect",
  "environment",
  "inconclusive",
]);
const ALLOWED_CONFIDENCE = new Set(["high", "medium", "low"]);
const DEFAULT_MAX_INPUT_CHARS = 120_000;

function stringValue(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

async function readText(filePath, maxChars = Infinity) {
  if (!filePath) return "";
  try {
    const value = await fs.readFile(filePath, "utf8");
    if (value.length <= maxChars) return value;
    return `${value.slice(0, maxChars)}\n\n[内容已截断，共 ${value.length} 字符]`;
  } catch {
    return "";
  }
}

async function readJson(filePath) {
  const value = await readText(filePath);
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

function testStatus(testCase) {
  const rawStatus = stringValue(testCase?.status).toLowerCase();
  const statusCode = Number(testCase?.statusCode);
  if (rawStatus === "passed" || statusCode === 0) return "passed";
  if (rawStatus === "error" || statusCode === -1) return "error";
  return "failed";
}

export function failureIdentity(value) {
  return createHash("sha256")
    .update(JSON.stringify([
      stringValue(value?.deviceId),
      stringValue(value?.suite),
      stringValue(value?.name),
      stringValue(value?.message),
      stringValue(value?.stack),
    ]))
    .digest("hex")
    .slice(0, 16);
}

export function collectUitestFailures(runnerResult) {
  const failures = [];
  for (const device of runnerResult?.runs?.swe?.devices || []) {
    for (const suite of device?.suiteResults || []) {
      for (const testCase of suite?.testCases || []) {
        const status = testStatus(testCase);
        if (status !== "failed" && status !== "error") continue;
        const failure = {
          deviceId: stringValue(device?.id),
          deviceProfile: stringValue(device?.profile),
          suite: stringValue(suite?.suiteClass || suite?.name),
          name: stringValue(testCase?.name),
          status,
          message: stringValue(testCase?.message),
          stack: stringValue(testCase?.stack),
        };
        failures.push({ failureId: failureIdentity(failure), ...failure });
      }
    }
  }
  return failures;
}

function patchPaths(patchText) {
  const values = [];
  const seen = new Set();
  for (const match of stringValue(patchText).matchAll(/^\+\+\+\s+b\/(.+)$/gm)) {
    const relativePath = match[1].trim();
    if (!relativePath || relativePath === "/dev/null" || seen.has(relativePath)) continue;
    seen.add(relativePath);
    values.push(relativePath);
  }
  return values;
}

function insideRoot(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function collectFinalSources(projectDirs, generatedPatch, maxChars) {
  const roots = [...new Set((Array.isArray(projectDirs) ? projectDirs : [projectDirs]).filter(Boolean))];
  if (!roots.length) return "（最终工程目录不可用）";
  const sections = [];
  let remaining = maxChars;
  for (const relativePath of patchPaths(generatedPatch).slice(0, 20)) {
    let filePath = "";
    for (const root of roots) {
      const candidate = path.resolve(root, relativePath);
      if (insideRoot(root, candidate) && await readText(candidate, 1)) {
        filePath = candidate;
        break;
      }
    }
    if (!filePath) continue;
    const content = await readText(filePath, Math.min(remaining, 18_000));
    if (!content) continue;
    const section = `### ${relativePath}\n\n${content}`;
    sections.push(section);
    remaining -= section.length;
    if (remaining <= 0) break;
  }
  return sections.length ? sections.join("\n\n") : "（changes.patch 未指向可读取的最终源码文件）";
}

function compactCommandLog(commandLog, failures, maxChars) {
  if (!commandLog) return "（无 commands.jsonl）";
  const needles = new Set();
  for (const failure of failures) {
    for (const value of [failure.deviceId, failure.suite, failure.name]) {
      const normalized = stringValue(value).trim();
      if (normalized) needles.add(normalized);
    }
  }
  const lines = commandLog.split(/\r?\n/).filter(Boolean);
  const selected = lines.filter((line) => {
    if ([...needles].some((needle) => line.includes(needle))) return true;
    return /\b(error|failed|failure|exception|assert|uitest|aa test|hdc)\b/i.test(line);
  });
  const value = (selected.length ? selected : lines.slice(-80)).join("\n");
  if (value.length <= maxChars) return value;
  return `${value.slice(-maxChars)}\n[日志前部已截断]`;
}

function fitSections(sections, maxChars) {
  let remaining = maxChars;
  const output = [];
  for (const { title, content } of sections) {
    if (remaining <= 0) break;
    const body = stringValue(content);
    const header = `## ${title}\n\n`;
    const allowed = Math.max(0, remaining - header.length);
    const clipped = body.length > allowed
      ? `${body.slice(0, Math.max(0, allowed - 30))}\n[本节已截断]`
      : body;
    output.push(`${header}${clipped}`);
    remaining -= header.length + clipped.length + 2;
  }
  return output.join("\n\n");
}

function parseJsonObject(raw) {
  const value = stringValue(raw).trim();
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  for (const candidate of [value, fenced]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // 继续尝试从说明文字中提取最外层对象。
    }
  }
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(value.slice(start, end + 1));
  throw new Error("诊断模型未返回 JSON 对象");
}

function cleanString(value, maxLength) {
  return stringValue(value).trim().slice(0, maxLength);
}

export function normalizeFailureAnalyses(raw, failures) {
  const expected = new Map(failures.map((item) => [item.failureId, item]));
  const seen = new Set();
  const analyses = [];
  for (const item of Array.isArray(raw?.analyses) ? raw.analyses : []) {
    const failureId = cleanString(item?.failureId, 64);
    if (!expected.has(failureId) || seen.has(failureId)) continue;
    const summary = cleanString(item?.summary, 2_000);
    if (!summary) continue;
    seen.add(failureId);
    analyses.push({
      failureId,
      category: ALLOWED_CATEGORIES.has(item?.category) ? item.category : "inconclusive",
      summary,
      evidence: (Array.isArray(item?.evidence) ? item.evidence : [])
        .map((value) => cleanString(value, 1_000))
        .filter(Boolean)
        .slice(0, 6),
      confidence: ALLOWED_CONFIDENCE.has(item?.confidence) ? item.confidence : "low",
      suggestion: cleanString(item?.suggestion, 2_000),
    });
  }
  if (!analyses.length) throw new Error("诊断 JSON 中没有可匹配的失败项");
  return analyses;
}

function diagnosticPrompt(evidence) {
  return `你是 UITest 失败诊断器，只负责分析，不负责修改代码。不得调用工具，不得访问工作目录之外的信息，不得生成或应用补丁。\n\n请基于下方证据判断每条失败的真正原因。断言文本和调用栈通常只是症状；需要把 PROMPT、Agent 修改、测试补丁、最终源码和 ohosTest 日志串起来说明因果。证据不足时必须选择 inconclusive，禁止猜测。不要使用或推断 golden patch。\n\n只输出一个合法 JSON 对象，不要 Markdown，不要额外说明，结构必须是：\n{"analyses":[{"failureId":"输入中的 ID","category":"implementation_defect|test_defect|environment|inconclusive","summary":"面向开发者的中文根因说明","evidence":["证据1","证据2"],"confidence":"high|medium|low","suggestion":"建议核查或修复的位置"}]}\n\n要求：每个 failureId 最多一项；summary 不要复述堆栈，要说明为什么失败；evidence 必须引用输入中的具体文件、日志或行为。\n\n${evidence}`;
}

export async function analyzeUitestFailures({
  client,
  model,
  caseInfo,
  agentResult,
  ohosTest,
  signal,
  maxInputChars = DEFAULT_MAX_INPUT_CHARS,
  sessionRunner = runMonitoredSession,
}) {
  const runnerResult = await readJson(ohosTest?.resultPath);
  const failures = collectUitestFailures(runnerResult);
  if (!failures.length) return null;

  const caseRunDir = path.dirname(agentResult.resultPath);
  const outputDir = path.join(caseRunDir, "failure-analysis");
  const resultPath = path.join(outputDir, "failure-analysis.json");
  const evidencePath = path.join(outputDir, "evidence.md");
  const outputPath = path.join(outputDir, "model-output.txt");
  await fs.mkdir(outputDir, { recursive: true });

  try {
    const generatedPatch = await readText(agentResult.patchPath, 35_000);
    const testPatch = await readText(ohosTest?.testPatchPath, 35_000);
    const prompt = await readText(caseInfo?.promptPath, 14_000);
    const metadata = await readText(ohosTest?.metadataPath, 12_000);
    const commandLog = await readText(
      ohosTest?.outputDir ? path.join(ohosTest.outputDir, "commands.jsonl") : "",
      100_000,
    );
    const summary = await readText(ohosTest?.summaryPath, 12_000);
    const finalSources = await collectFinalSources(
      [ohosTest?.workDir, agentResult.projectDir],
      generatedPatch,
      38_000,
    );
    const evidence = fitSections([
      { title: "失败项（failureId 是输出关联键）", content: JSON.stringify(failures, null, 2) },
      { title: "需求 PROMPT.md", content: prompt || "（缺失）" },
      { title: "metadata.json", content: metadata || "（缺失）" },
      { title: "Agent changes.patch", content: generatedPatch || "（无修改）" },
      { title: "test_patch.patch", content: testPatch || "（缺失）" },
      { title: "最终工程中被修改的源码", content: finalSources },
      { title: "ohosTest 摘要", content: summary || "（缺失）" },
      { title: "ohosTest 相关命令与日志", content: compactCommandLog(commandLog, failures, 32_000) },
    ], maxInputChars);
    await fs.writeFile(evidencePath, `${evidence}\n`, "utf8");

    const session = await client.createSession(outputDir, 120);
    const sessionId = stringValue(session?.id);
    if (!sessionId) throw new Error("OpenCode 创建失败诊断 session 后未返回 session id");
    const monitored = await sessionRunner({
      client,
      sessionId,
      projectDir: outputDir,
      payload: {
        parts: [{ type: "text", text: diagnosticPrompt(evidence) }],
        agent: "plan",
        model: { providerID: model.providerId, modelID: model.modelId },
      },
      eventsPath: path.join(outputDir, "opencode-sse.jsonl"),
      pollingPath: path.join(outputDir, "opencode-polling.jsonl"),
      idleTimeoutSec: 180,
      maxRuntimeSec: 600,
      signal,
    });
    const modelOutput = stringValue(monitored?.output);
    await fs.writeFile(outputPath, modelOutput, "utf8");
    const analyses = normalizeFailureAnalyses(parseJsonObject(modelOutput), failures);
    const result = {
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      status: "completed",
      generatedAt: new Date().toISOString(),
      case: caseInfo?.name || agentResult.case,
      model: { providerId: model.providerId, modelId: model.modelId, agent: "plan" },
      sessionId,
      evidencePath,
      outputPath,
      failures,
      analyses,
    };
    await writeJson(resultPath, result);
    return { status: "completed", resultPath, evidencePath, outputPath, sessionId };
  } catch (error) {
    const result = {
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      status: "failed",
      generatedAt: new Date().toISOString(),
      case: caseInfo?.name || agentResult.case,
      model: { providerId: model?.providerId || "", modelId: model?.modelId || "", agent: "plan" },
      error: error.message,
      failures,
    };
    await writeJson(resultPath, result).catch(() => {});
    return { status: "failed", resultPath, evidencePath, outputPath, error: error.message };
  }
}

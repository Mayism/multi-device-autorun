import fs from "node:fs/promises";
import path from "node:path";

const SOURCE_EXTENSIONS = new Set([".ets", ".ts", ".js", ".json", ".json5"]);
const SOURCE_SCAN_EXCLUDES = new Set([".git", ".hvigor", "build", "node_modules"]);

function text(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

async function readText(filePath, maxChars = 500_000) {
  if (!filePath) return "";
  try {
    return (await fs.readFile(filePath, "utf8")).slice(0, maxChars);
  } catch {
    return "";
  }
}

function insideRoot(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function stackLocation(stack) {
  const value = text(stack);
  const match = value.match(/\((.+?):(\d+):(\d+)\)/) || value.match(/\bat\s+(.+?):(\d+):(\d+)\b/);
  if (!match) return null;
  return {
    functionName: value.match(/\bat\s+([^\s(]+)/)?.[1] || "",
    relativePath: match[1].replace(/\\/g, "/"),
    line: Number(match[2]),
    column: Number(match[3]),
  };
}

function fileFromPatch(patchText, relativePath) {
  const marker = `+++ b/${text(relativePath).replace(/\\/g, "/")}`;
  const start = text(patchText).indexOf(marker);
  if (start < 0) return "";
  const block = text(patchText).slice(start + marker.length).split(/^diff --git /m)[0];
  const output = [];
  let inHunk = false;
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+") || line.startsWith(" ")) output.push(line.slice(1));
  }
  return output.join("\n");
}

async function findTestSource(location, roots, testPatch) {
  if (!location) return "";
  for (const root of roots.filter(Boolean)) {
    const candidate = path.resolve(root, location.relativePath);
    if (!insideRoot(root, candidate)) continue;
    const content = await readText(candidate);
    if (content) return content;
  }
  return fileFromPatch(testPatch, location.relativePath);
}

function selectorAtLocation(source, location) {
  if (!source || !location) return null;
  const lines = source.split(/\r?\n/);
  const index = Math.max(0, location.line - 1);
  const nearby = lines.slice(Math.max(0, index - 5), Math.min(lines.length, index + 6)).join("\n");
  const exactLine = lines[index] || "";
  const pattern = /ON\.(id|text|type|description|key)\(\s*(['"`])([^'"`]+)\2\s*\)/;
  const match = exactLine.match(pattern) || nearby.match(pattern);
  if (!match) return null;
  const action = exactLine.match(/\.(click|longClick|inputText|scroll|dragTo|pinchOut|pinchIn)\s*\(/)?.[1]
    || nearby.match(/\.(click|longClick|inputText|scroll|dragTo|pinchOut|pinchIn)\s*\(/)?.[1]
    || "interact";
  return {
    lookupMethod: match[1],
    value: match[3],
    action,
    sourceLine: exactLine.trim() || nearby.trim(),
  };
}

function assertionAfterFailure(source, failureName, location) {
  if (!source || !failureName) return { executed: false, expression: "" };
  const escaped = failureName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = source.search(new RegExp(`\\bit\\(\\s*['\"]${escaped}['\"]`));
  if (start < 0) return { executed: false, expression: "" };
  const body = source.slice(start, start + 6_000);
  const assertion = body.match(/expect\(([^\n]+?)\)\.(assert\w+)\(([^\n]*?)\)/);
  return {
    executed: false,
    expression: assertion ? `expect(${assertion[1]}).${assertion[2]}(${assertion[3]})` : "",
    reason: location?.functionName
      ? `异常从等待执行的 ${location.functionName} 返回，后续断言未执行`
      : "异常发生在断言之前，后续断言未执行",
  };
}

async function walk(root, files, limit = 6_000) {
  if (!root || files.length >= limit) return;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= limit) return;
    if (entry.isDirectory() && SOURCE_SCAN_EXCLUDES.has(entry.name)) continue;
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) await walk(filePath, files, limit);
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(filePath);
  }
}

async function sourceIndex(roots, selectors) {
  const uniqueRoots = [...new Set(roots.filter(Boolean).map((root) => path.resolve(root)))];
  const files = [];
  for (const root of uniqueRoots) await walk(root, files);
  const records = [];
  const seen = new Set();
  for (const filePath of files) {
    if (seen.has(filePath) || filePath.includes(`${path.sep}ohosTest${path.sep}`)) continue;
    seen.add(filePath);
    const content = await readText(filePath);
    if (!content) continue;
    const isResource = /[\\/]resources[\\/](?:base|zh_CN)[\\/]element[\\/][^/\\]+\.json$/.test(filePath);
    const isDynamicRouteView = /\.id\(\s*route\.to\s*\)/.test(content);
    if (!isResource && !isDynamicRouteView && !selectors.some((value) => content.includes(value))) continue;
    const root = uniqueRoots.find((candidate) => insideRoot(candidate, filePath)) || "";
    records.push({
      relativePath: path.relative(root, filePath).replace(/\\/g, "/"),
      content,
    });
  }
  return records;
}

function resolveResource(records, name) {
  const candidates = records
    .filter((record) => /\/resources\/(?:base|zh_CN)\/element\/[^/]+\.json$/.test(`/${record.relativePath}`))
    .sort((left, right) => Number(!left.relativePath.includes("/base/")) - Number(!right.relativePath.includes("/base/")));
  for (const record of candidates) {
    try {
      const parsed = JSON.parse(record.content);
      const item = (parsed?.string || []).find((entry) => entry?.name === name);
      if (item?.value != null) return { value: text(item.value), sourcePath: record.relativePath };
    } catch {
      // 非严格 JSON 资源文件不参与自动映射。
    }
  }
  return null;
}

function resolveTarget(records, selector) {
  const escaped = selector.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let mapping = null;
  for (const record of records) {
    const lines = record.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const direct = selector.lookupMethod === "id"
        && new RegExp(`\\.id\\(\\s*['\"]${escaped}['\"]\\s*\\)`).test(lines[index]);
      const route = selector.lookupMethod === "id"
        && new RegExp(`\\bto\\s*:\\s*['\"]${escaped}['\"]`).test(lines[index]);
      if (!direct && !route) continue;
      let contextStart = Math.max(0, index - 10);
      let contextEnd = Math.min(lines.length, index + 5);
      if (route) {
        for (let cursor = index; cursor >= 0; cursor -= 1) {
          if (lines[cursor].includes("{")) {
            contextStart = cursor;
            break;
          }
        }
        for (let cursor = index; cursor < lines.length; cursor += 1) {
          if (lines[cursor].includes("}")) {
            contextEnd = cursor + 1;
            break;
          }
        }
      }
      const context = lines.slice(contextStart, contextEnd).join("\n");
      mapping = {
        sourcePath: record.relativePath,
        sourceLine: index + 1,
        resourceName: context.match(/\$r\(\s*['"]app\.string\.([^'"]+)['"]\s*\)/)?.[1] || "",
        componentType: context.match(/\b(Button|Text|Image|ListItem|Row|Column)\s*\(/)?.[1] || "",
      };
      break;
    }
    if (mapping) break;
  }

  if (!mapping) mapping = { sourcePath: "", sourceLine: 0, resourceName: "", componentType: "" };
  if (!mapping.componentType && mapping.resourceName) {
    const view = records.find((record) => /\.id\(\s*route\.to\s*\)/.test(record.content));
    mapping.componentType = view?.content.match(/\b(Button|Text|Image|ListItem|Row|Column)\s*\(\s*route\.title\s*\)/)?.[1] || "";
    mapping.viewSourcePath = view?.relativePath || "";
  }
  const resource = mapping.resourceName ? resolveResource(records, mapping.resourceName) : null;
  return {
    componentType: mapping.componentType,
    clickable: selector.action === "click" || selector.action === "longClick",
    displayText: resource?.value || (selector.lookupMethod === "text" ? selector.value : ""),
    textResource: mapping.resourceName ? `app.string.${mapping.resourceName}` : "",
    sourcePath: mapping.sourcePath,
    sourceLine: mapping.sourceLine,
    viewSourcePath: mapping.viewSourcePath || "",
    resourceSourcePath: resource?.sourcePath || "",
  };
}

function localAnalysis(failure, interaction) {
  const actionLabels = { click: "点击", longClick: "长按", inputText: "输入文本" };
  const lookupLabels = { id: "ID", text: "文本", type: "控件类型", description: "描述", key: "Key" };
  const action = actionLabels[interaction.action] || "操作";
  const lookup = lookupLabels[interaction.locator.type] || interaction.locator.type;
  const targetText = interaction.target.displayText ? `界面文案为“${interaction.target.displayText}”的` : "";
  const returned = interaction.result.returnedValue ? `，${interaction.lookupApi} 返回 ${interaction.result.returnedValue}` : "";
  const pageState = interaction.target.displayText
    ? `用例尚未进入“${interaction.target.displayText}”页面`
    : "用例尚未完成前置交互";
  const assertionName = /statusBarRect\.height/.test(interaction.assertion.expression)
    ? "状态栏高度断言"
    : "后续业务断言";
  const featureName = /hide_status_bar/i.test(failure.name) ? "状态栏隐藏功能" : "被测功能";
  const summary = `${interaction.phase}失败：测试通过 ${lookup}“${interaction.locator.value}”查找${targetText}可${action}控件，但没有找到该控件${returned}，导致${action}失败。${pageState}，${assertionName}没有执行，因此本次结果不能证明${featureName}存在问题。`;
  const evidence = [
    `${interaction.testSource}:${interaction.testLine} 使用 ${interaction.lookupApi}(ON.${interaction.locator.type}('${interaction.locator.value}')) 后执行 ${interaction.action}`,
  ];
  if (interaction.target.sourcePath) {
    evidence.push(`${interaction.target.sourcePath}:${interaction.target.sourceLine} 将“${interaction.locator.value}”映射到目标入口`);
  }
  if (interaction.target.textResource && interaction.target.displayText) {
    evidence.push(`${interaction.target.textResource} 的资源文案为“${interaction.target.displayText}”`);
  }
  return {
    failureId: failure.failureId,
    category: "interaction_failure",
    summary,
    uxReason: summary,
    expectedBehavior: `找到并${action}${interaction.target.displayText ? `“${interaction.target.displayText}”` : "目标"}控件，完成前置交互后执行被测功能断言。`,
    actualBehavior: `通过${lookup}“${interaction.locator.value}”没有找到目标控件，${action}未完成。`,
    technicalCause: `失败发生在业务断言之前；现有证据能确定控件定位失败，但不足以判断控件未出现的更深层原因。`,
    evidence,
    confidence: "high",
    suggestion: "结合失败时的 UI 树和截图检查当前页面、控件渲染时机及定位属性。",
    interaction,
    source: "deterministic_fallback",
  };
}

export async function buildFailureInteractionContext(failures, {
  projectRoots = [],
  testRoots = [],
  testPatch = "",
} = {}) {
  const located = [];
  for (const failure of failures) {
    const location = stackLocation(failure.stack);
    const source = await findTestSource(location, testRoots, testPatch);
    const selector = selectorAtLocation(source, location);
    located.push({ failure, location, source, selector });
  }
  const selectors = [...new Set(located.map((item) => item.selector?.value).filter(Boolean))];
  if (!selectors.length) return { failures, fallbackAnalyses: [] };
  const records = await sourceIndex(projectRoots, selectors);
  const enriched = [];
  const fallbackAnalyses = [];
  for (const item of located) {
    if (!item.selector) {
      enriched.push(item.failure);
      continue;
    }
    const target = resolveTarget(records, item.selector);
    const notFound = /\b(?:null|undefined)\b/i.test(item.failure.message)
      && /findComponent/.test(item.selector.sourceLine);
    const interaction = {
      phase: /(?:enter|open|navigate)/i.test(item.location?.functionName || "") ? "前置导航" : "前置交互",
      action: item.selector.action,
      lookupApi: item.selector.sourceLine.match(/\b(findComponent|waitForComponent|assertComponentExist)\b/)?.[1] || "findComponent",
      locator: { type: item.selector.lookupMethod, value: item.selector.value },
      target,
      result: {
        status: notFound ? "not_found" : "interaction_failed",
        returnedValue: notFound ? (/undefined/i.test(item.failure.message) ? "undefined" : "null") : "",
      },
      assertion: assertionAfterFailure(item.source, item.failure.name, item.location),
      testSource: item.location?.relativePath || "",
      testLine: item.location?.line || 0,
    };
    const failure = { ...item.failure, interaction };
    const fallback = localAnalysis(failure, interaction);
    interaction.conclusion = fallback.summary;
    enriched.push(failure);
    fallbackAnalyses.push(fallback);
  }
  return { failures: enriched, fallbackAnalyses };
}

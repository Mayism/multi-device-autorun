import type { WorkspaceFile } from "../../evidence/types.js";

export interface ArkuiComponentPropertyCall {
  name: string;
  argumentText: string;
  line: number;
  usesBreakpoint: boolean;
}

export interface ArkuiComponentInstance {
  componentId?: string;
  component: string;
  filePath: string;
  line: number;
  startIndex: number;
  endIndex: number;
  argumentText: string;
  properties: ArkuiComponentPropertyCall[];
  parentId?: string;
  parentComponent?: string;
  childIds?: string[];
  childComponents?: string[];
  source?: "arkFacts" | "legacyScanner";
  breakpointContext?: "if" | "switch";
  breakpointCondition?: string;
}

export interface ArkuiStaticScanIndex {
  componentInstances: ArkuiComponentInstance[];
  constants: Record<string, string>;
  files: Array<{ relativePath: string; componentCount: number }>;
}

const COMPONENT_CALL_PATTERN = /\b([A-Z][A-Za-z0-9_]*)\s*\(/g;
const BREAKPOINT_PATTERN =
  /\b(?:breakpoint|currentBreakpoint|curBp|WidthBreakpoint|Breakpoint|sm|md|lg|xl)\b/i;

export function buildArkuiStaticScanIndex(files: WorkspaceFile[]): ArkuiStaticScanIndex {
  const componentInstances = files
    .filter((file) => file.relativePath.endsWith(".ets"))
    .flatMap((file) => scanFile(file));

  const componentCountByFile = new Map<string, number>();
  for (const instance of componentInstances) {
    componentCountByFile.set(
      instance.filePath,
      (componentCountByFile.get(instance.filePath) ?? 0) + 1,
    );
  }

  return {
    componentInstances,
    constants: collectConstants(files),
    files: [...componentCountByFile].map(([relativePath, componentCount]) => ({
      relativePath,
      componentCount,
    })),
  };
}

function collectConstants(files: WorkspaceFile[]): Record<string, string> {
  const constants: Record<string, string> = {};
  for (const file of files.filter((item) => item.relativePath.endsWith(".ets"))) {
    for (const match of file.content.matchAll(
      /\bstatic\s+readonly\s+([A-Z][A-Z0-9_]*)\s*(?::[^=;]+)?=\s*([^;]+);/g,
    )) {
      const name = match[1];
      const value = match[2]?.trim();
      if (name && value) {
        constants[name] = value;
      }
    }
    for (const match of file.content.matchAll(
      /\b(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=;]+)?=\s*([^;]+);/g,
    )) {
      const name = match[1];
      const value = match[2]?.trim();
      if (name && value) {
        constants[name] = value;
      }
    }
  }
  return constants;
}

function scanFile(file: WorkspaceFile): ArkuiComponentInstance[] {
  const strippedContent = stripCommentsAndStrings(file.content);
  const instances: ArkuiComponentInstance[] = [];

  for (const match of strippedContent.matchAll(COMPONENT_CALL_PATTERN)) {
    const component = match[1];
    const openParenIndex = match.index === undefined ? -1 : match.index + match[0].lastIndexOf("(");
    if (!component || openParenIndex < 0) {
      continue;
    }

    const closeParenIndex = findBalancedEnd(strippedContent, openParenIndex, "(", ")");
    if (closeParenIndex === undefined) {
      continue;
    }

    instances.push({
      component,
      filePath: file.relativePath,
      line: lineAt(strippedContent, match.index ?? 0),
      startIndex: match.index ?? 0,
      endIndex: skipArkuiChildrenBlock(strippedContent, closeParenIndex + 1),
      argumentText: file.content.slice(openParenIndex + 1, closeParenIndex).trim(),
      properties: scanPropertyChain(file.content, strippedContent, closeParenIndex + 1),
      ...readBreakpointContext(file.content, strippedContent, match.index ?? 0),
    });
  }

  return instances;
}

function scanPropertyChain(
  originalContent: string,
  strippedContent: string,
  startIndex: number,
): ArkuiComponentPropertyCall[] {
  const properties: ArkuiComponentPropertyCall[] = [];
  let cursor = skipArkuiChildrenBlock(strippedContent, startIndex);

  while (cursor < strippedContent.length) {
    cursor = skipWhitespace(strippedContent, cursor);
    if (strippedContent[cursor] !== ".") {
      break;
    }

    const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(strippedContent.slice(cursor + 1));
    if (!nameMatch?.[0]) {
      break;
    }

    const name = nameMatch[0];
    const openParenIndex = skipWhitespace(strippedContent, cursor + 1 + name.length);
    if (strippedContent[openParenIndex] !== "(") {
      break;
    }

    const closeParenIndex = findBalancedEnd(strippedContent, openParenIndex, "(", ")");
    if (closeParenIndex === undefined) {
      break;
    }

    const argumentText = originalContent.slice(openParenIndex + 1, closeParenIndex).trim();
    properties.push({
      name,
      argumentText,
      line: lineAt(strippedContent, cursor),
      usesBreakpoint: BREAKPOINT_PATTERN.test(argumentText),
    });
    cursor = skipArkuiChildrenBlock(strippedContent, closeParenIndex + 1);
  }

  return properties;
}

function skipArkuiChildrenBlock(content: string, startIndex: number): number {
  const afterWhitespace = skipWhitespace(content, startIndex);
  if (content[afterWhitespace] !== "{") {
    return afterWhitespace;
  }
  return (findBalancedEnd(content, afterWhitespace, "{", "}") ?? afterWhitespace) + 1;
}

function readBreakpointContext(
  originalContent: string,
  strippedContent: string,
  index: number,
): Pick<ArkuiComponentInstance, "breakpointContext" | "breakpointCondition"> {
  const strippedPrefix = strippedContent.slice(Math.max(0, index - 400), index);
  const originalPrefix = originalContent.slice(Math.max(0, index - 400), index);
  const strippedRecentLines = strippedPrefix.split(/\r?\n/).slice(-8).join("\n");
  const originalRecentLines = originalPrefix.split(/\r?\n/).slice(-8).join("\n");
  if (!BREAKPOINT_PATTERN.test(originalRecentLines)) {
    return {};
  }
  if (/\bswitch\s*\(/.test(strippedRecentLines)) {
    return { breakpointContext: "switch", breakpointCondition: originalRecentLines.trim() };
  }
  if (/\bif\s*\(/.test(strippedRecentLines)) {
    return { breakpointContext: "if", breakpointCondition: originalRecentLines.trim() };
  }
  return {};
}

function findBalancedEnd(
  content: string,
  openIndex: number,
  openToken: string,
  closeToken: string,
): number | undefined {
  let depth = 0;
  for (let index = openIndex; index < content.length; index += 1) {
    if (content[index] === openToken) {
      depth += 1;
    } else if (content[index] === closeToken) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}

function skipWhitespace(content: string, startIndex: number): number {
  let cursor = startIndex;
  while (/\s/.test(content[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

function lineAt(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/).length;
}

function stripCommentsAndStrings(content: string): string {
  let output = "";
  let index = 0;
  let mode: "code" | "line_comment" | "block_comment" | "single" | "double" | "template" = "code";

  while (index < content.length) {
    const current = content[index] ?? "";
    const next = content[index + 1] ?? "";

    if (mode === "line_comment") {
      if (current === "\n") {
        mode = "code";
        output += "\n";
      } else {
        output += " ";
      }
      index += 1;
      continue;
    }

    if (mode === "block_comment") {
      if (current === "*" && next === "/") {
        output += "  ";
        mode = "code";
        index += 2;
      } else {
        output += current === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }

    if (mode === "single" || mode === "double" || mode === "template") {
      const quote = mode === "single" ? "'" : mode === "double" ? '"' : "`";
      if (current === "\\" && next) {
        output += "  ";
        index += 2;
        continue;
      }
      if (current === quote) {
        output += " ";
        mode = "code";
      } else {
        output += current === "\n" ? "\n" : " ";
      }
      index += 1;
      continue;
    }

    if (current === "/" && next === "/") {
      output += "  ";
      mode = "line_comment";
      index += 2;
      continue;
    }
    if (current === "/" && next === "*") {
      output += "  ";
      mode = "block_comment";
      index += 2;
      continue;
    }
    if (current === "'") {
      output += " ";
      mode = "single";
      index += 1;
      continue;
    }
    if (current === '"') {
      output += " ";
      mode = "double";
      index += 1;
      continue;
    }
    if (current === "`") {
      output += " ";
      mode = "template";
      index += 1;
      continue;
    }

    output += current;
    index += 1;
  }

  return output;
}

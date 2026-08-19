import path from "node:path";
import type { RegisteredRule } from "../../types/ruleTypes.js";
import type { CollectedEvidence } from "../../evidence/types.js";
import type { EvaluatedRule } from "../shared.js";

function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => new RegExp(pattern, "m"));
}

function shouldKeepComments(patterns: string[]): boolean {
  return patterns.some(
    (pattern) => pattern.includes("@ts-ignore") || pattern.includes("@ts-nocheck"),
  );
}

function splitLines(source: string): string[] {
  return source.split(/\r?\n/);
}

// stripCommentsPreserveLayout 仅移除注释内容，并尽量保留换行与列宽，避免影响按行规则。
function stripCommentsPreserveLayout(source: string): string {
  let result = "";
  let index = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplateString = false;
  let escaped = false;

  while (index < source.length) {
    const current = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (inLineComment) {
      if (current === "\n") {
        inLineComment = false;
        result += "\n";
      } else {
        result += " ";
      }
      index += 1;
      continue;
    }

    if (inBlockComment) {
      if (current === "*" && next === "/") {
        result += "  ";
        inBlockComment = false;
        index += 2;
        continue;
      }
      result += current === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }

    if (inSingleQuote || inDoubleQuote || inTemplateString) {
      result += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (
        (inSingleQuote && current === "'") ||
        (inDoubleQuote && current === '"') ||
        (inTemplateString && current === "`")
      ) {
        inSingleQuote = false;
        inDoubleQuote = false;
        inTemplateString = false;
      }
      index += 1;
      continue;
    }

    if (current === "/" && next === "/") {
      result += "  ";
      inLineComment = true;
      index += 2;
      continue;
    }

    if (current === "/" && next === "*") {
      result += "  ";
      inBlockComment = true;
      index += 2;
      continue;
    }

    if (current === "'") {
      inSingleQuote = true;
      result += current;
      index += 1;
      continue;
    }

    if (current === '"') {
      inDoubleQuote = true;
      result += current;
      index += 1;
      continue;
    }

    if (current === "`") {
      inTemplateString = true;
      result += current;
      index += 1;
      continue;
    }

    result += current;
    index += 1;
  }

  return result;
}

interface TextPatternMatch {
  relativePath: string;
  lineLocations: string[];
  lineSnippets: string[];
}

function toGlobalRegExp(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

function isIndexInsideStringLiteral(source: string, targetIndex: number): boolean {
  let index = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplateString = false;
  let escaped = false;

  while (index < targetIndex) {
    const current = source[index] ?? "";

    if (inSingleQuote || inDoubleQuote || inTemplateString) {
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (
        (inSingleQuote && current === "'") ||
        (inDoubleQuote && current === '"') ||
        (inTemplateString && current === "`")
      ) {
        inSingleQuote = false;
        inDoubleQuote = false;
        inTemplateString = false;
      }
      index += 1;
      continue;
    }

    if (current === "'") {
      inSingleQuote = true;
    } else if (current === '"') {
      inDoubleQuote = true;
    } else if (current === "`") {
      inTemplateString = true;
    }
    index += 1;
  }

  return inSingleQuote || inDoubleQuote || inTemplateString;
}

function stripStringLiteralContentsPreserveLayout(source: string): string {
  let result = "";
  let index = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplateString = false;
  let escaped = false;

  while (index < source.length) {
    const current = source[index] ?? "";

    if (inSingleQuote || inDoubleQuote || inTemplateString) {
      result += current === "\n" ? "\n" : " ";
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (
        (inSingleQuote && current === "'") ||
        (inDoubleQuote && current === '"') ||
        (inTemplateString && current === "`")
      ) {
        inSingleQuote = false;
        inDoubleQuote = false;
        inTemplateString = false;
      }
      index += 1;
      continue;
    }

    if (current === "'") {
      inSingleQuote = true;
      result += " ";
    } else if (current === '"') {
      inDoubleQuote = true;
      result += " ";
    } else if (current === "`") {
      inTemplateString = true;
      result += " ";
    } else {
      result += current;
    }
    index += 1;
  }

  return result;
}

function buildLineStarts(source: string): number[] {
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }
  return lineStarts;
}

function findLineNumber(lineStarts: number[], sourceIndex: number): number {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const current = lineStarts[middle] ?? 0;
    const next = lineStarts[middle + 1] ?? Number.POSITIVE_INFINITY;

    if (sourceIndex >= current && sourceIndex < next) {
      return middle + 1;
    }
    if (sourceIndex < current) {
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }

  return lineStarts.length;
}

function findMatchingLineNumbers(
  patterns: RegExp[],
  content: string,
  ignoreStringLiteralMatches: boolean,
): number[] {
  const lineStarts = buildLineStarts(content);
  const lineNumbers = new Set<number>();

  for (const pattern of patterns) {
    const globalPattern = toGlobalRegExp(pattern);
    let match: RegExpExecArray | null;
    while ((match = globalPattern.exec(content)) !== null) {
      if (!ignoreStringLiteralMatches || !isIndexInsideStringLiteral(content, match.index)) {
        lineNumbers.add(findLineNumber(lineStarts, match.index));
      }

      if (match[0].length === 0) {
        globalPattern.lastIndex += 1;
      }
    }
  }

  return Array.from(lineNumbers).sort((left, right) => left - right);
}

function findFinallyBlockControlFlowLineNumbers(content: string): number[] {
  const lineStarts = buildLineStarts(content);
  const lineNumbers = new Set<number>();
  const finallyPattern = /\bfinally\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = finallyPattern.exec(content)) !== null) {
    const blockStart = match.index + match[0].lastIndexOf("{");
    let depth = 1;
    let index = blockStart + 1;

    while (index < content.length && depth > 0) {
      const current = content[index] ?? "";
      if (current === "{") {
        depth += 1;
        index += 1;
        continue;
      }
      if (current === "}") {
        depth -= 1;
        index += 1;
        continue;
      }
      if (depth > 0) {
        const tokenMatch = /\b(?:return|break|continue|throw)\b/.exec(content.slice(index));
        if (!tokenMatch) {
          break;
        }
        const tokenIndex = index + tokenMatch.index;
        const nextBraceIndex = content.slice(index).search(/[{}]/);
        if (nextBraceIndex !== -1 && index + nextBraceIndex < tokenIndex) {
          index += nextBraceIndex;
          continue;
        }
        lineNumbers.add(findLineNumber(lineStarts, tokenIndex));
        index = tokenIndex + tokenMatch[0].length;
        continue;
      }
      index += 1;
    }
  }

  return Array.from(lineNumbers).sort((left, right) => left - right);
}

function findTextPatternMatch(
  file: CollectedEvidence["workspaceFiles"][number],
  patterns: RegExp[],
  keepComments: boolean,
  ignoreStringLiteralMatches: boolean,
  stripStringLiteralContents: boolean,
  finallyBlockControlFlowOnly: boolean,
): TextPatternMatch | undefined {
  const commentNormalizedContent = keepComments
    ? file.content
    : stripCommentsPreserveLayout(file.content);
  const normalizedContent = stripStringLiteralContents
    ? stripStringLiteralContentsPreserveLayout(commentNormalizedContent)
    : commentNormalizedContent;
  const allowedLineNumbers =
    file.patchLineNumbers === undefined ? undefined : new Set(file.patchLineNumbers);
  const matchingLineNumbers = (
    finallyBlockControlFlowOnly
      ? findFinallyBlockControlFlowLineNumbers(normalizedContent)
      : findMatchingLineNumbers(patterns, normalizedContent, ignoreStringLiteralMatches)
  ).filter((lineNumber) => allowedLineNumbers === undefined || allowedLineNumbers.has(lineNumber));

  if (matchingLineNumbers.length === 0) {
    return undefined;
  }

  const originalLines = splitLines(file.content);
  const seenLocations = new Set<string>();
  const lineLocations: string[] = [];
  const lineSnippets: string[] = [];

  matchingLineNumbers.forEach((lineNumber) => {
    const location = `${file.relativePath}:${lineNumber}`;
    if (seenLocations.has(location)) {
      return;
    }

    seenLocations.add(location);
    lineLocations.push(location);
    lineSnippets.push(`${location}: ${(originalLines[lineNumber - 1] ?? "").trim()}`);
  });

  return {
    relativePath: file.relativePath,
    lineLocations,
    lineSnippets,
  };
}

// 文本规则完全由规则包中的 detector_config 驱动。
export function runTextPatternRule(
  rule: RegisteredRule,
  evidence: CollectedEvidence,
): EvaluatedRule {
  const fileExtensions = ((rule.detector.config.fileExtensions as string[] | undefined) ?? []).map(
    (item) => item.toLowerCase(),
  );
  const applicabilityPatternTexts = (
    (rule.detector.config.applicabilityPatterns as string[] | undefined) ?? []
  ).filter(Boolean);
  const patternTexts = ((rule.detector.config.patterns as string[] | undefined) ?? []).filter(
    Boolean,
  );
  const applicabilityPatterns = compilePatterns(applicabilityPatternTexts);
  const patterns = compilePatterns(patternTexts);
  const keepComments = shouldKeepComments([...applicabilityPatternTexts, ...patternTexts]);
  const ignoreStringLiteralMatches = rule.detector.config.ignoreStringLiteralMatches === true;
  const stripStringLiteralContents = rule.detector.config.stripStringLiteralContents === true;
  const finallyBlockControlFlowOnly = rule.detector.config.finallyBlockControlFlowOnly === true;
  const candidateFiles = evidence.workspaceFiles.filter((file) =>
    fileExtensions.includes(path.extname(file.relativePath).toLowerCase()),
  );
  const applicabilityMatches = candidateFiles
    .map((file) =>
      findTextPatternMatch(
        file,
        applicabilityPatterns,
        keepComments,
        ignoreStringLiteralMatches,
        stripStringLiteralContents,
        finallyBlockControlFlowOnly,
      ),
    )
    .filter((match): match is TextPatternMatch => Boolean(match));

  if (applicabilityPatterns.length > 0 && applicabilityMatches.length === 0) {
    return {
      rule_id: rule.rule_id,
      rule_source: rule.rule_source,
      result: "不涉及",
      conclusion: "未发现该规则的适用场景。",
      matchedFiles: [],
      matchedLocations: [],
      matchedSnippets: [],
    };
  }

  const matches = candidateFiles
    .map((file) =>
      findTextPatternMatch(
        file,
        patterns,
        keepComments,
        ignoreStringLiteralMatches,
        stripStringLiteralContents,
        finallyBlockControlFlowOnly,
      ),
    )
    .filter((match): match is TextPatternMatch => Boolean(match));
  const matchedFiles = matches.map((match) => match.relativePath);
  const matchedLocations = matches.flatMap((match) => match.lineLocations);
  const matchedSnippets = matches.flatMap((match) => match.lineSnippets);
  const conclusionLocations = matchedLocations.length > 0 ? matchedLocations : matchedFiles;

  return {
    rule_id: rule.rule_id,
    rule_source: rule.rule_source,
    result: matchedFiles.length > 0 ? "不满足" : "满足",
    conclusion:
      matchedFiles.length > 0
        ? `${rule.summary} 检测到规则命中，文件：${conclusionLocations.join(", ")}`
        : applicabilityPatterns.length > 0
          ? "检测到规则适用场景，未发现违规命中。"
          : "未发现该规则的命中证据。",
    matchedFiles,
    matchedLocations,
    matchedSnippets,
  };
}

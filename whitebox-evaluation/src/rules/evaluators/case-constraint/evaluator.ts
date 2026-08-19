import type { RegisteredRule } from "../../types/ruleTypes.js";
import type { CollectedEvidence } from "../../evidence/types.js";
import type { EvaluatedRule } from "../shared.js";
import type { CaseRuleStaticPrecheck } from "../../../types.js";

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  let regex = "^";

  for (let index = 0; index < pattern.length; ) {
    const current = pattern[index] ?? "";
    const next = pattern[index + 1] ?? "";

    if (current === "*" && next === "*") {
      regex += ".*";
      index += 2;
      continue;
    }

    if (current === "*") {
      regex += "[^/]*";
      index += 1;
      continue;
    }

    regex += escapeRegex(current);
    index += 1;
  }

  regex += "$";
  return new RegExp(regex);
}

function matchesCaseTargetPattern(relativePath: string, pattern: string): boolean {
  return globToRegExp(pattern).test(relativePath);
}

function getSignalTokens(signal: Record<string, string>): string[] {
  return Object.entries(signal)
    .filter(([key]) => key !== "type")
    .map(([, value]) => value)
    .filter(Boolean);
}

type KitRequirementKind = "arkui_builtin_component" | "external_kit_api";

interface KitRequirement {
  rawText: string;
  kind: KitRequirementKind;
  symbols: string[];
  namespace?: string;
}

interface KitEvidence {
  matchedTokens: string[];
  matchedFiles: string[];
  strongMatchCount: number;
  weakMatchCount: number;
  summaries: string[];
}

function extractIdentifierTokens(text: string): string[] {
  return text.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function classifyKitRequirement(item: string): KitRequirement {
  const [namespacePart, ...restParts] = item.split(":");
  const searchablePart = restParts.length > 0 ? restParts.join(":") : item;
  const symbols = uniqueStrings(
    extractIdentifierTokens(searchablePart).filter((token) => token.length >= 4),
  );
  const namespace = namespacePart?.trim();

  return {
    rawText: item,
    kind: /arkui/i.test(item) ? "arkui_builtin_component" : "external_kit_api",
    symbols,
    namespace: namespace && namespace !== item ? namespace : undefined,
  };
}

function hasArkuiSymbolEvidence(content: string, symbol: string): boolean {
  return (
    new RegExp(`\\b${escapeRegex(symbol)}\\s*\\(`).test(content) ||
    new RegExp(`\\b${escapeRegex(symbol)}\\b`).test(content)
  );
}

function isWeakArkuiSymbol(symbol: string): boolean {
  return symbol === "display" || symbol === "aspectRatio";
}

function hasExternalKitStrongEvidence(
  content: string,
  requirement: KitRequirement,
  symbol: string,
): boolean {
  const importLines = content
    .split(/\r?\n/)
    .filter((line) => /^\s*import\b/.test(line) && /kit/i.test(line));
  const hasKitImportForSymbol = importLines.some(
    (line) =>
      line.includes(symbol) ||
      (requirement.namespace
        ? line.toLowerCase().includes(requirement.namespace.toLowerCase())
        : false),
  );
  if (hasKitImportForSymbol) {
    return true;
  }

  if (requirement.namespace) {
    return new RegExp(
      `\\b${escapeRegex(requirement.namespace)}\\s*\\.\\s*${escapeRegex(symbol)}\\b`,
    ).test(content);
  }

  return false;
}

function findFilesContainingToken(
  candidateFiles: CollectedEvidence["workspaceFiles"],
  token: string,
  options: { patchScoped: boolean },
): CollectedEvidence["workspaceFiles"] {
  return candidateFiles.filter((file) => getSearchableContent(file, options).includes(token));
}

function collectKitEvidence(
  candidateFiles: CollectedEvidence["workspaceFiles"],
  kit: string[],
  options: { patchScoped: boolean },
): KitEvidence {
  const matchedTokens = new Set<string>();
  const matchedFiles = new Set<string>();
  const summaries: string[] = [];
  let strongMatchCount = 0;
  let weakMatchCount = 0;

  for (const requirement of kit.map(classifyKitRequirement)) {
    if (requirement.symbols.length === 0) {
      continue;
    }

    if (requirement.kind === "arkui_builtin_component") {
      const matchedSymbols = requirement.symbols.filter((symbol) => {
        const matchedCandidateFiles = candidateFiles.filter((file) =>
          hasArkuiSymbolEvidence(getSearchableContent(file, options), symbol),
        );
        for (const file of matchedCandidateFiles) {
          matchedFiles.add(file.relativePath);
        }
        return matchedCandidateFiles.length > 0;
      });

      for (const symbol of matchedSymbols) {
        matchedTokens.add(symbol);
      }

      const strongMatchedSymbols = matchedSymbols.filter((symbol) => !isWeakArkuiSymbol(symbol));
      const weakMatchedSymbols = matchedSymbols.filter(isWeakArkuiSymbol);
      if (strongMatchedSymbols.length > 0) {
        strongMatchCount += 1;
        summaries.push(
          `Kit 静态锚点：ArkUI 内置组件或强符号 ${strongMatchedSymbols.join("、")} 已在目标文件中使用。`,
        );
        if (weakMatchedSymbols.length > 0) {
          weakMatchCount += 1;
          summaries.push(
            `Kit 静态锚点：同时发现弱锚点 ${weakMatchedSymbols.join("、")}，仅作为阅读入口。`,
          );
        }
      } else if (weakMatchedSymbols.length > 0) {
        weakMatchCount += 1;
        summaries.push(
          `Kit 静态锚点：仅发现弱锚点 ${weakMatchedSymbols.join("、")}，不能单独证明规则适用或满足。`,
        );
      } else {
        summaries.push(
          `Kit 静态锚点：ArkUI 内置组件或符号 ${requirement.symbols.join("、")} 未在目标文件中出现。`,
        );
      }
      continue;
    }

    const strongMatchedSymbols = requirement.symbols.filter((symbol) => {
      const matchedCandidateFiles = candidateFiles.filter((file) =>
        hasExternalKitStrongEvidence(getSearchableContent(file, options), requirement, symbol),
      );
      for (const file of matchedCandidateFiles) {
        matchedFiles.add(file.relativePath);
      }
      return matchedCandidateFiles.length > 0;
    });
    const weakMatchedSymbols = requirement.symbols.filter((symbol) => {
      if (strongMatchedSymbols.includes(symbol)) {
        return false;
      }
      const matchedCandidateFiles = findFilesContainingToken(candidateFiles, symbol, options);
      for (const file of matchedCandidateFiles) {
        matchedFiles.add(file.relativePath);
      }
      return matchedCandidateFiles.length > 0;
    });

    for (const symbol of [...strongMatchedSymbols, ...weakMatchedSymbols]) {
      matchedTokens.add(symbol);
    }

    if (strongMatchedSymbols.length > 0) {
      strongMatchCount += 1;
      summaries.push(
        `Kit 静态锚点：发现 external kit/API 的导入或调用链证据：${strongMatchedSymbols.join("、")}。`,
      );
    } else if (weakMatchedSymbols.length > 0) {
      weakMatchCount += 1;
      summaries.push(
        `Kit 静态锚点：仅发现疑似同名本地方法或弱文本命中：${weakMatchedSymbols.join("、")}，未发现 external kit/API 来源证据。`,
      );
    } else {
      summaries.push(
        `Kit 静态锚点：未发现 external kit/API 来源证据：${requirement.symbols.join("、")}。`,
      );
    }
  }

  return {
    matchedTokens: [...matchedTokens],
    matchedFiles: [...matchedFiles],
    strongMatchCount,
    weakMatchCount,
    summaries,
  };
}

function getPatchScopedContent(file: CollectedEvidence["workspaceFiles"][number]): string {
  if (file.patchLineNumbers === undefined) {
    return file.content;
  }

  const lines = file.content.split(/\r?\n/);
  return file.patchLineNumbers.map((lineNumber) => lines[lineNumber - 1] ?? "").join("\n");
}

function getSearchableContent(
  file: CollectedEvidence["workspaceFiles"][number],
  options: { patchScoped: boolean },
): string {
  return options.patchScoped ? getPatchScopedContent(file) : file.content;
}

function buildStaticPrecheck(
  candidateFiles: CollectedEvidence["workspaceFiles"],
  astSignals: Array<Record<string, string>>,
  kit: string[],
): CaseRuleStaticPrecheck {
  const targetFiles = candidateFiles.map((file) => file.relativePath);
  if (candidateFiles.length === 0) {
    return {
      target_matched: false,
      target_files: [],
      signal_status: "no_target_files",
      matched_tokens: [],
      summary: "静态预判未找到匹配目标文件。",
    };
  }

  const matchedTokens = new Set<string>();
  const matchedFiles = new Set<string>();
  let matchedSignalCount = 0;
  const kitRequirements = kit
    .map(classifyKitRequirement)
    .filter((requirement) => requirement.symbols.length > 0);
  const kitEvidence = collectKitEvidence(candidateFiles, kit, { patchScoped: false });

  for (const signal of astSignals) {
    const tokens = getSignalTokens(signal);
    const tokenMatches = tokens.filter((token) => {
      const matchedCandidateFiles = candidateFiles.filter((file) =>
        getPatchScopedContent(file).includes(token),
      );
      for (const file of matchedCandidateFiles) {
        matchedFiles.add(file.relativePath);
      }
      return matchedCandidateFiles.length > 0;
    });

    if (tokenMatches.length === tokens.length && tokens.length > 0) {
      matchedSignalCount += 1;
    }

    for (const token of tokenMatches) {
      matchedTokens.add(token);
    }
  }

  for (const token of kitEvidence.matchedTokens) {
    matchedTokens.add(token);
  }
  for (const file of kitEvidence.matchedFiles) {
    matchedFiles.add(file);
  }

  let signalStatus: CaseRuleStaticPrecheck["signal_status"] = "none_matched";
  const hasAllAstSignals =
    matchedSignalCount > 0 && matchedSignalCount === astSignals.length && astSignals.length > 0;
  const hasAllKitAnchors = kitEvidence.strongMatchCount > 0 && kitRequirements.length > 0;
  if (hasAllAstSignals || hasAllKitAnchors) {
    signalStatus = "all_matched";
  } else if (matchedSignalCount > 0 || kitEvidence.weakMatchCount > 0) {
    signalStatus = "partial_matched";
  }

  const matchedSignalText =
    astSignals.length > 0 ? `${matchedSignalCount}/${astSignals.length}` : "0/0";
  const kitAnchorText =
    kitRequirements.length > 0
      ? `Kit 静态锚点强证据命中 ${kitEvidence.strongMatchCount}/${kitRequirements.length}。${kitEvidence.summaries.join("")}`
      : undefined;
  const summaryParts = [`静态预判在目标文件中命中了 ${matchedSignalText} 个 AST 信号。`];
  if (kitAnchorText) {
    summaryParts.push(kitAnchorText);
  }

  return {
    target_matched: true,
    target_files: targetFiles,
    matched_files: [...matchedFiles],
    signal_status: signalStatus,
    matched_tokens: [...matchedTokens],
    summary: summaryParts.join(" "),
  };
}

export function runCaseConstraintRule(
  rule: RegisteredRule,
  evidence: CollectedEvidence,
): EvaluatedRule {
  const targetPatterns = (rule.detector.config.targetPatterns as string[] | undefined) ?? [];
  const astSignals =
    (rule.detector.config.astSignals as Array<Record<string, string>> | undefined) ?? [];
  const kit = (rule.detector.config.kit as string[] | undefined) ?? [];
  const candidateFiles = evidence.workspaceFiles.filter((file) =>
    targetPatterns.some((pattern) => matchesCaseTargetPattern(file.relativePath, pattern)),
  );
  const staticPrecheck = buildStaticPrecheck(candidateFiles, astSignals, kit);

  return {
    rule_id: rule.rule_id,
    rule_source: rule.rule_source,
    result: "未接入判定器",
    conclusion: `${staticPrecheck.summary} 仅作为辅助证据，不作为最终结论。`,
    matchedFiles: staticPrecheck.matched_files ?? [],
    preliminaryData: {
      static_precheck: staticPrecheck,
    },
  };
}

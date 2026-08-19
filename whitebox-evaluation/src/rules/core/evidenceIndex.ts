import type { RuleEvidenceIndex } from "../../types.js";
import type { CollectedEvidence } from "../evidence/types.js";
import type { EvaluatedRule } from "../evaluators/shared.js";

// 将 evaluator 的命中位置和片段归一化成报告、Agent 和评分共用的 evidence index。
export function buildRuleEvidenceIndex(
  evaluatedRules: EvaluatedRule[],
  evidence: CollectedEvidence,
): RuleEvidenceIndex {
  const ruleEvidenceIndex: RuleEvidenceIndex = Object.fromEntries(
    evaluatedRules.map((rule) => [
      rule.rule_id,
      {
        evidenceFiles: getRuleEvidenceFiles(rule),
        evidenceSnippets: getRuleEvidenceSnippets(rule, evidence.workspaceFiles),
      },
    ]),
  );
  const fallbackEvidenceFiles =
    evidence.changedFiles.length > 0
      ? evidence.changedFiles.slice(0, 3)
      : evidence.workspaceFiles.slice(0, 3).map((file) => file.relativePath);

  ruleEvidenceIndex.__fallback__ = {
    evidenceFiles: fallbackEvidenceFiles,
    evidenceSnippets: fallbackEvidenceFiles
      .map((relativePath) => normalizeWorkspaceRelativePath(relativePath))
      .map(
        (relativePath) =>
          evidence.workspaceFiles.find((file) => file.relativePath === relativePath)?.content ?? "",
      )
      .filter(Boolean)
      .map((content) => content.slice(0, 200)),
  };

  return ruleEvidenceIndex;
}

function normalizeWorkspaceRelativePath(relativePath: string): string {
  return relativePath.replace(/^workspace\//, "").replace(/^original\//, "");
}

export function getRuleEvidenceFiles(rule: EvaluatedRule): string[] {
  return (rule.matchedLocations?.length ?? 0) > 0
    ? (rule.matchedLocations ?? [])
    : rule.matchedFiles;
}

function getRuleEvidenceSnippets(
  rule: EvaluatedRule,
  workspaceFiles: CollectedEvidence["workspaceFiles"],
): string[] {
  if ((rule.matchedSnippets?.length ?? 0) > 0) {
    return rule.matchedSnippets ?? [];
  }

  return rule.matchedFiles
    .map(
      (relativePath) =>
        workspaceFiles.find((file) => file.relativePath === relativePath)?.content ?? "",
    )
    .filter(Boolean)
    .map((content) => content.slice(0, 200));
}

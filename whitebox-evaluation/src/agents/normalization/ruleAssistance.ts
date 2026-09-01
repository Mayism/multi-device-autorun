import path from "node:path";
import type {
  AgentAssistedRuleResult,
  AgentRunStatus,
  AgentBootstrapPayload,
  AgentBootstrapRuleCandidate,
  AssistedRuleCandidate,
  ConstraintSummary,
  LoadedRubricSnapshot,
  RuleAuditResult,
  TaskType,
} from "../../types.js";
import type { LoadedRubric } from "../../scoring/rubricLoader.js";

type BuildAgentPromptPayloadInput = {
  caseInput: {
    caseId: string;
    promptText: string;
    originalProjectPath: string;
    generatedProjectPath: string;
    patchPath?: string;
  };
  caseRoot: string;
  effectivePatchPath?: string;
  taskType: TaskType;
  taskUnderstanding: ConstraintSummary;
  assistedRuleCandidates: AssistedRuleCandidate[];
};

const MAX_BOOTSTRAP_REPRESENTATIVE_FILES = 5;

type MergeRuleAuditResultsInput = {
  deterministicRuleResults: RuleAuditResult[];
  assistedRuleCandidates: AssistedRuleCandidate[];
  agentFinalAnswer?: AgentAssistedRuleResult;
};

type MergeRuleAuditResultsOutput = {
  ruleAgentRunStatus: AgentRunStatus;
  ruleAgentAssessmentResult: AgentAssistedRuleResult | null;
  mergedRuleAuditResults: RuleAuditResult[];
};

function toPosixPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return (
    relativePath.length === 0 || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function normalizeGeneratedProjectPathForTools(
  filePath: string,
  input: BuildAgentPromptPayloadInput,
): string {
  const normalizedFilePath = toPosixPath(filePath).replace(/^\.\//, "");
  if (normalizedFilePath.startsWith("generated/") || normalizedFilePath.startsWith("original/")) {
    return normalizedFilePath;
  }

  if (path.isAbsolute(filePath)) {
    if (isPathInside(input.caseRoot, filePath)) {
      return toPosixPath(path.relative(input.caseRoot, filePath));
    }
    if (isPathInside(input.caseInput.generatedProjectPath, filePath)) {
      return `generated/${toPosixPath(path.relative(input.caseInput.generatedProjectPath, filePath))}`;
    }
    if (isPathInside(input.caseInput.originalProjectPath, filePath)) {
      return `original/${toPosixPath(path.relative(input.caseInput.originalProjectPath, filePath))}`;
    }
    return normalizedFilePath;
  }

  return `generated/${normalizedFilePath}`;
}

function normalizeAssistedRuleCandidatePaths(
  candidate: AssistedRuleCandidate,
  input: BuildAgentPromptPayloadInput,
): AssistedRuleCandidate {
  return {
    ...candidate,
    evidence_files: candidate.evidence_files.map((filePath) =>
      normalizeGeneratedProjectPathForTools(filePath, input),
    ),
    static_precheck: candidate.static_precheck
      ? {
          ...candidate.static_precheck,
          target_files: candidate.static_precheck.target_files.map((filePath) =>
            normalizeGeneratedProjectPathForTools(filePath, input),
          ),
        }
      : undefined,
  };
}

// buildRubricSnapshot 只保留评分 prompt 真正需要的摘要，避免把整份 rubric 传给 Agent。
export function buildRubricSnapshot(rubric: LoadedRubric): LoadedRubricSnapshot {
  return {
    task_type: rubric.taskType,
    evaluation_mode: rubric.evaluationMode,
    scenario: rubric.scenario,
    scoring_method: rubric.scoringMethod,
    scoring_note: rubric.scoringNote,
    common_risks: rubric.commonRisks,
    report_emphasis: rubric.reportEmphasis,
    dimension_summaries: rubric.dimensions.map((dimension) => ({
      name: dimension.name,
      weight: dimension.weight,
      intent: dimension.intent,
      item_summaries: dimension.items.map((item) => ({
        name: item.name,
        weight: item.weight,
        scoring_bands: item.scoringBands.map((band) => ({
          score: band.score,
          criteria: band.criteria,
        })),
      })),
    })),
    hard_gates: rubric.hardGates.map((gate) => ({
      id: gate.id,
      score_cap: gate.scoreCap,
    })),
    review_rule_summary:
      rubric.reviewRules.scoreBands.length > 0 ? ["关键分段分数需要人工复核"] : [],
  };
}

// buildAgentBootstrapPayload 把评分上下文组织成 opencode 规则判定载荷。
export function buildAgentBootstrapPayload(
  input: BuildAgentPromptPayloadInput,
): AgentBootstrapPayload {
  const assistedRuleCandidates = input.assistedRuleCandidates.map((candidate) =>
    compactAssistedRuleCandidateForBootstrap(
      normalizeAssistedRuleCandidatePaths(candidate, input),
    ),
  );

  return {
    case_context: {
      case_id: input.caseInput.caseId,
      case_root: input.caseRoot,
      task_type: input.taskType,
      original_prompt_summary: input.caseInput.promptText,
      original_project_path: input.caseInput.originalProjectPath,
      generated_project_path: input.caseInput.generatedProjectPath,
      effective_patch_path: input.effectivePatchPath,
    },
    task_understanding: input.taskUnderstanding,
    assisted_rule_candidates: assistedRuleCandidates,
  };
}

function compactAssistedRuleCandidateForBootstrap(
  candidate: AssistedRuleCandidate,
): AgentBootstrapRuleCandidate {
  const targetChecks = compactTargetChecks(candidate.target_checks);
  const evidenceFiles = candidate.static_precheck
    ? undefined
    : compactStrings(candidate.evidence_files);
  const kit = compactStrings(candidate.kit ?? []);
  const matchedFiles = candidate.static_precheck?.matched_files ?? [];
  const targetFiles = candidate.static_precheck?.target_files ?? [];
  const representativeSourceFiles =
    candidate.static_precheck?.signal_status === "none_matched" ||
    candidate.static_precheck?.signal_status === "no_target_files"
      ? [...matchedFiles, ...candidate.evidence_files]
      : [...matchedFiles, ...candidate.evidence_files, ...targetFiles];
  const representativeFiles = compactStrings(
    uniqueStrings(representativeSourceFiles).slice(0, MAX_BOOTSTRAP_REPRESENTATIVE_FILES),
  );
  const matchedTokens = compactStrings(candidate.static_precheck?.matched_tokens ?? []);
  const staticPrecheck = candidate.static_precheck
    ? {
        target_matched: candidate.static_precheck.target_matched,
        signal_status: candidate.static_precheck.signal_status,
        target_file_count: uniqueStrings([...candidate.evidence_files, ...targetFiles]).length,
        ...(matchedTokens ? { matched_tokens: matchedTokens } : {}),
        ...(representativeFiles ? { representative_files: representativeFiles } : {}),
      }
    : undefined;

  return {
    rule_id: candidate.rule_id,
    ...(candidate.rule_name ? { rule_name: candidate.rule_name } : {}),
    why_uncertain: mergeCandidateReason(candidate.why_uncertain, candidate.static_precheck?.summary),
    ...(evidenceFiles ? { evidence_files: evidenceFiles } : {}),
    ...(candidate.review_evidence ? { review_evidence: candidate.review_evidence } : {}),
    ...(kit ? { kit } : {}),
    ...(!targetChecks && typeof candidate.llm_prompt === "string"
      ? { llm_prompt: candidate.llm_prompt }
      : {}),
    ...(targetChecks ? { target_checks: targetChecks } : {}),
    ...(candidate.decision_criteria ? { decision_criteria: candidate.decision_criteria } : {}),
    ...(staticPrecheck ? { static_precheck: staticPrecheck } : {}),
  };
}

function mergeCandidateReason(whyUncertain: string, staticSummary?: string): string {
  const summary = staticSummary?.trim();
  const reason = whyUncertain.trim();

  if (!summary) {
    return reason;
  }
  if (!reason || reason === summary) {
    return summary;
  }
  if (reason.startsWith(summary)) {
    return reason;
  }
  return `${summary} ${reason}`;
}

function compactStrings(values: string[]): string[] | undefined {
  const compacted = values.filter((value) => value.length > 0);
  return compacted.length > 0 ? compacted : undefined;
}

function compactTargetChecks(
  targetChecks: AssistedRuleCandidate["target_checks"],
): AgentBootstrapRuleCandidate["target_checks"] {
  if (!targetChecks || targetChecks.length === 0) {
    return undefined;
  }

  const compacted = targetChecks.map((check) => ({
    target: check.target,
    ...(check.ast_signals.length > 0 ? { ast_signals: check.ast_signals } : {}),
    llm_prompt: check.llm_prompt,
  }));
  return compacted.length > 0 ? compacted : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function formatAgentSummaryForFallback(
  summary?: AgentAssistedRuleResult["summary"],
): string | undefined {
  if (!summary) {
    return undefined;
  }
  return `Agent 总体判断：${summary.assistant_scope}（整体置信度：${summary.overall_confidence}）。`;
}

function formatStaticPrecheckForFallback(candidate: AssistedRuleCandidate): string | undefined {
  const parts: string[] = [];

  if (candidate.static_precheck?.summary) {
    parts.push(`静态预判：${candidate.static_precheck.summary}`);
  } else if (candidate.why_uncertain) {
    parts.push(`静态预判：${candidate.why_uncertain}`);
  }

  if (candidate.local_preliminary_signal) {
    parts.push(`本地预判信号：${candidate.local_preliminary_signal}。`);
  }

  const evidenceFiles = candidate.evidence_files.length
    ? candidate.evidence_files
    : (candidate.static_precheck?.target_files ?? []);
  if (evidenceFiles.length > 0) {
    parts.push(`相关证据文件：${evidenceFiles.slice(0, 5).join("、")}。`);
  }

  return parts.length > 0 ? parts.join(" ") : undefined;
}

function inferTrustedStaticResult(candidate: AssistedRuleCandidate): RuleAuditResult["result"] {
  const staticPrecheck = candidate.static_precheck;
  if (!staticPrecheck) {
    return "待人工复核";
  }

  if (staticPrecheck.signal_status === "no_target_files") {
    return "不满足";
  }

  if (staticPrecheck.signal_status === "all_matched") {
    return "满足";
  }

  if (staticPrecheck.signal_status === "none_matched" && (candidate.ast_signals?.length ?? 0) > 0) {
    return "不满足";
  }

  return "待人工复核";
}

function makeFallbackResult(
  candidate: AssistedRuleCandidate,
  summary?: AgentAssistedRuleResult["summary"],
): RuleAuditResult {
  const summaryText = formatAgentSummaryForFallback(summary);
  const staticPrecheckText = formatStaticPrecheckForFallback(candidate);
  const result = inferTrustedStaticResult(candidate);
  const staticScoringText =
    result === "待人工复核" ? undefined : "静态预判结果已作为评分依据，仍建议人工复核确认。";
  const fallbackText = summaryText
    ? `${summaryText} 但缺少针对 ${candidate.rule_id} 的结构化判定，已回退为待人工复核。`
    : `Agent 未能提供有效判定，候选规则 ${candidate.rule_id} 已回退为待人工复核。`;
  const conclusionParts = [fallbackText, staticScoringText, staticPrecheckText].filter(Boolean);
  return {
    rule_id: candidate.rule_id,
    rule_summary: candidate.rule_summary ?? candidate.rule_name,
    rule_source: candidate.rule_source,
    result,
    conclusion: conclusionParts.join(" "),
  };
}

function mapAgentDecisionToRuleResult(
  decision: "violation" | "pass" | "not_applicable" | "uncertain",
): RuleAuditResult["result"] {
  switch (decision) {
    case "violation":
      return "不满足";
    case "pass":
      return "满足";
    case "not_applicable":
      return "不涉及";
    case "uncertain":
      return "待人工复核";
  }
}

const IRRELEVANT_AGENT_CONCLUSION =
  "Agent 输出结论与规则描述不相关，已阻断自动合并。建议人工复核或重新执行本用例以获得可信规则判定";

const CODE_ANCHOR_STOP_WORDS = new Set([
  "target",
  "rules",
  "rule",
  "true",
  "false",
  "null",
  "undefined",
  "current",
  "generated",
  "original",
  "metadata",
  "patch",
]);

const CHINESE_ANCHOR_STOP_PATTERN =
  /必须|不得|禁止|检查|是否|方案|代码|规则|当前|新增|存在|使用|通过|说明|明确|优先|涉及|需要|应当|应该|要求|支持|实现|处理|判断|判定|输出|完成|完整|相关|对应|目标|文件|函数|方法|逻辑|能力|场景|状态|策略|结构|系统|统一|修复|根因|原因|不能|只|未|给出|如果|当|时|前|后|中|下|上|并|且|和|与|或|的|为|到/g;

function normalizeForRelevance(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

function collectRuleText(candidate: AssistedRuleCandidate): string {
  const parts = [
    candidate.rule_summary,
    candidate.rule_name,
    candidate.llm_prompt,
    ...(candidate.kit ?? []),
    ...(candidate.ast_signals ?? []).map((signal) => signal.name),
    ...(candidate.target_checks ?? []).flatMap((check) => [
      check.target,
      check.llm_prompt,
      ...(check.ast_signals ?? []).map((signal) => signal.name),
    ]),
  ];
  return parts.filter((part): part is string => Boolean(part)).join(" ");
}

function extractCodeAnchors(text: string): string[] {
  const anchors = new Set<string>();
  const matches = text.match(/[A-Za-z_$@][A-Za-z0-9_$@.:-]{2,}/g) ?? [];
  for (const match of matches) {
    const normalized = match.replace(/^@+/, "").toLowerCase();
    if (normalized.length < 4 || CODE_ANCHOR_STOP_WORDS.has(normalized)) {
      continue;
    }
    if (/^\d+$/.test(normalized)) {
      continue;
    }
    anchors.add(normalized);
  }
  return [...anchors];
}

function extractChineseAnchors(text: string): string[] {
  const anchors = new Set<string>();
  const chineseRuns = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const run of chineseRuns) {
    const candidates = run
      .replace(CHINESE_ANCHOR_STOP_PATTERN, " ")
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2 && item.length <= 12);
    for (const candidate of candidates) {
      anchors.add(candidate);
    }
  }
  return [...anchors];
}

function hasAnyAnchorHit(anchors: string[], text: string): boolean {
  return anchors.some((anchor) => text.includes(normalizeForRelevance(anchor)));
}

function isAgentAssessmentIrrelevantToRule(
  candidate: AssistedRuleCandidate,
  assessment: AgentAssistedRuleResult["rule_assessments"][number],
): boolean {
  if (!candidate.is_case_rule || assessment.decision === "uncertain") {
    return false;
  }

  const ruleText = collectRuleText(candidate);
  if (!ruleText) {
    return false;
  }

  const assessmentText = normalizeForRelevance(
    `${assessment.reason} ${assessment.evidence_used.join(" ")}`,
  );
  const codeAnchors = extractCodeAnchors(ruleText);
  const chineseAnchors = extractChineseAnchors(ruleText);

  if (codeAnchors.length === 0 && chineseAnchors.length === 0) {
    return false;
  }

  return !hasAnyAnchorHit(codeAnchors, assessmentText) && !hasAnyAnchorHit(chineseAnchors, assessmentText);
}

function isNonCaseMustRuleAbsentFromPatch(
  candidate: AssistedRuleCandidate,
  assessment: AgentAssistedRuleResult["rule_assessments"][number],
): boolean {
  if (
    candidate.rule_source !== "must_rule" ||
    candidate.is_case_rule ||
    assessment.decision !== "uncertain"
  ) {
    return false;
  }

  const text = `${assessment.reason} ${assessment.evidence_used.join(" ")}`;
  return /补丁|patch|effective\.patch|read_patch/i.test(text) && /未(发现|见)|没有|无/.test(text);
}

function isNoIssueJudgementOnChangedCode(
  assessment: AgentAssistedRuleResult["rule_assessments"][number],
): boolean {
  if (assessment.decision !== "uncertain") {
    return false;
  }

  const text = `${assessment.reason} ${assessment.evidence_used.join(" ")}`;
  const mentionsChangedCode = /新增代码|新增内容|新增改动|补丁|patch|effective\.patch|改动/.test(
    text,
  );
  const saysNoIssue =
    /未(发现|见)(明显)?(该规则相关)?(违规|问题|风险|异常|反模式)/.test(text) ||
    /没有(发现)?(该规则相关)?(违规|问题|风险|异常|反模式)/.test(text) ||
    /无(明显)?(该规则相关)?(违规|问题|风险|异常|反模式)/.test(text);

  return mentionsChangedCode && saysNoIssue;
}

function cleanNoIssueConclusion(reason: string): string {
  const cleaned = reason
    .replace(/，?需要人工(?:review|复核)确认。?/gi, "")
    .replace(/，?需人工(?:review|复核)确认。?/gi, "")
    .trim();
  return cleaned.length > 0 ? cleaned : "新增代码未发现该规则相关问题。";
}

function mapAgentAssessmentToRuleResult(
  candidate: AssistedRuleCandidate,
  assessment: AgentAssistedRuleResult["rule_assessments"][number],
): RuleAuditResult {
  if (isAgentAssessmentIrrelevantToRule(candidate, assessment)) {
    return {
      rule_id: candidate.rule_id,
      rule_summary: candidate.rule_summary ?? candidate.rule_name,
      rule_source: candidate.rule_source,
      result: "待人工复核",
      conclusion: IRRELEVANT_AGENT_CONCLUSION,
    };
  }

  if (isNonCaseMustRuleAbsentFromPatch(candidate, assessment)) {
    return {
      rule_id: candidate.rule_id,
      rule_summary: candidate.rule_summary ?? candidate.rule_name,
      rule_source: candidate.rule_source,
      result: "满足",
      conclusion: `${assessment.reason} 补丁未见相关改动，按 patch-only 评测视为无问题。`,
    };
  }

  if (isNoIssueJudgementOnChangedCode(assessment)) {
    return {
      rule_id: candidate.rule_id,
      rule_summary: candidate.rule_summary ?? candidate.rule_name,
      rule_source: candidate.rule_source,
      result: "满足",
      conclusion: `${cleanNoIssueConclusion(assessment.reason)} 新增代码未见相关问题，按 patch-only 评测视为无问题。`,
    };
  }

  return {
    rule_id: candidate.rule_id,
    rule_summary: candidate.rule_summary ?? candidate.rule_name,
    rule_source: candidate.rule_source,
    result: mapAgentDecisionToRuleResult(assessment.decision),
    conclusion: assessment.reason,
  };
}

// mergeRuleAuditResults 负责本地优先合并，保证非法输出时仍能稳定回退。
export function mergeRuleAuditResults(
  input: MergeRuleAuditResultsInput,
): MergeRuleAuditResultsOutput {
  const agentResult = input.agentFinalAnswer;
  if (!agentResult) {
    return {
      ruleAgentRunStatus: "invalid_output",
      ruleAgentAssessmentResult: null,
      mergedRuleAuditResults: [
        ...input.deterministicRuleResults,
        ...input.assistedRuleCandidates.map((candidate) => makeFallbackResult(candidate)),
      ],
    };
  }

  const assessmentByRuleId = new Map(
    agentResult.rule_assessments.map((item) => [item.rule_id, item]),
  );
  const mergedCandidates = input.assistedRuleCandidates.map((candidate) => {
    const assessment = assessmentByRuleId.get(candidate.rule_id);
    if (!assessment) {
      if (agentResult.rule_assessments.length === 0) {
        return makeFallbackResult(candidate, agentResult.summary);
      }
      return {
        rule_id: candidate.rule_id,
        rule_summary: candidate.rule_summary ?? candidate.rule_name,
        rule_source: candidate.rule_source,
        result: "待人工复核" as const,
        conclusion: `Agent 未提供规则 ${candidate.rule_id} 的分条判定，已回退为待人工复核。`,
      };
    }

    return mapAgentAssessmentToRuleResult(candidate, assessment);
  });

  return {
    ruleAgentRunStatus: "success",
    ruleAgentAssessmentResult: {
      summary: agentResult.summary,
      rule_assessments: agentResult.rule_assessments,
    },
    mergedRuleAuditResults: [...input.deterministicRuleResults, ...mergedCandidates],
  };
}

export interface RuleDecisionCriteria {
  pass?: string[];
  fail?: string[];
  not_applicable?: string[];
  review?: string[];
}

export type TaskType = "full_generation" | "continuation" | "bug_fix";

export interface RemoteTaskFileManifest {
  files: Array<{
    path: string;
    content: string;
  }>;
}

export interface RemoteTestCase {
  id: number;
  name: string;
  type: string;
  description: string;
  input: string;
  expectedOutput: string;
  fileUrl: string;
}

export interface RemoteExecutionResult {
  isBuildSuccess: boolean;
  outputCodeUrl: string;
  diffFileUrl?: string;
}

export interface RemoteEvaluationTask {
  taskId: number;
  testCase: RemoteTestCase;
  executionResult: RemoteExecutionResult;
  token?: string;
  callback: string;
}

export interface RemoteCallbackPayload {
  success?: boolean;
  taskId: number;
  status: "pending" | "running" | "completed" | "failed";
  totalScore?: number;
  maxScore?: number;
  resultData?: Record<string, unknown>;
  errorMessage?: string;
}

// CaseInput 描述单条评分用例的 before/after/prompt/patch 四元组。
export interface CaseInput {
  caseId: string;
  promptText: string;
  originalProjectPath: string;
  generatedProjectPath: string;
  originalProjectProvided?: boolean;
  patchPath?: string;
  expectedConstraintsPath?: string;
}

export type CaseConstraintPriority = "P0" | "P1";

export interface CaseRuleDefinition {
  pack_id: string;
  rule_id: string;
  rule_name: string;
  rule_source: "must_rule" | "should_rule";
  summary: string;
  priority: CaseConstraintPriority;
  detector_kind: "case_constraint";
  detector_config: {
    targetPatterns: string[];
    astSignals: Array<Record<string, string>>;
    llmPrompt: string;
    kit?: string[];
    targetChecks?: Array<{
      target: string;
      astSignals: Array<Record<string, string>>;
      llmPrompt: string;
    }>;
  };
  fallback_policy: "agent_assisted";
  is_case_rule: true;
}

export interface ConstraintSummary {
  explicitConstraints: string[];
  contextualConstraints: string[];
  implicitConstraints: string[];
  classificationHints: string[];
  crossDeviceAdaptation: CrossDeviceAdaptationUnderstanding;
}

export type CrossDeviceAdaptationApplicability =
  | "involved"
  | "not_involved"
  | "uncertain";

export interface CrossDeviceAdaptationUnderstanding {
  applicability: CrossDeviceAdaptationApplicability;
  confidence: ConfidenceLevel;
  reasons: string[];
}

export interface ProjectStructureSummary {
  rootPath: string;
  topLevelEntries: string[];
  modulePaths: string[];
  implementationHints: string[];
  omittedFileCount: number;
}

export interface PatchSummary {
  hasPatch: boolean;
  changedFiles: string[];
  affectedRoots: string[];
  addedLines: number;
  deletedLines: number;
  changeTypes: string[];
  intrusionLevel: "none" | "low" | "medium" | "high";
  rawPatchLength: number;
}

export interface TaskUnderstandingAgentInput {
  caseId: string;
  promptText: string;
  originalProjectPath: string;
  generatedProjectPath: string;
  originalProjectProvided?: boolean;
  taskType: TaskType;
  projectStructure: ProjectStructureSummary;
  patchSummary: PatchSummary;
}

export interface RuleAuditResult {
  rule_id: string;
  rule_summary?: string;
  rule_source: "must_rule" | "should_rule" | "forbidden_pattern";
  result: "满足" | "不满足" | "不涉及" | "待人工复核";
  conclusion: string;
  official_linter_severity?: OfficialLinterFinding["severity"];
  finding_count?: number;
  findings?: Array<{
    file: string;
    line?: number;
    column?: number;
    severity: OfficialLinterFinding["severity"];
    message: string;
  }>;
}

export interface NormalizedRuleImpact {
  rule_id: string;
  rule_source:
    | RuleAuditResult["rule_source"]
    | "official_linter"
    | "case_constraint";
  result: RuleAuditResult["result"];
  severity: "critical" | "major" | "minor" | "info" | "review";
  score_effect: {
    mode: "none" | "hard_gate" | "cap" | "deduct" | "review_only";
    score_cap?: number;
    points?: number;
    reason: string;
  };
}

export type OfficialLinterRunStatus =
  | "not_enabled"
  | "not_installed"
  | "success"
  | "failed"
  | "timeout"
  | "invalid_output";

export interface OfficialLinterFinding {
  rule_id: string;
  message: string;
  severity: "suggestion" | "warn" | "error" | "unknown";
  file: string;
  line?: number;
  column?: number;
  source_rule_set: string;
}

export interface OfficialLinterSummary {
  configuredRuleSets: string[];
  effectiveFindingCount: number;
  runStatus: OfficialLinterRunStatus;
  exitCode?: number;
  durationMs: number;
  diagnostics?: string;
}

export type HvigorBuildCheckStatus =
  | "not_enabled"
  | "skipped"
  | "tool_unavailable"
  | "success"
  | "failed"
  | "timeout";

export type AgentBuildAttemptOutcome =
  | "succeeded"
  | "failed"
  | "interrupted"
  | "running"
  | "unknown";

export interface AgentBuildAttempt {
  callId: string;
  command: string;
  tasks: string[];
  outcome: AgentBuildAttemptOutcome;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  description: string;
}

export interface AgentBuildResult {
  source: "agent";
  status: "success" | "failed" | "interrupted" | "not_run" | "unknown";
  finalAttemptStatus: AgentBuildAttemptOutcome | "not_run";
  attempts: AgentBuildAttempt[];
  summary: {
    attempts: number;
    succeeded: number;
    failed: number;
    interrupted: number;
    running: number;
  };
}

export interface HvigorBuildCheckModuleResult {
  modulePath: string;
  moduleName: string;
  command: "assembleHar" | "assembleHap" | "assembleHsp" | "assembleApp";
  status: "success" | "failed" | "timeout" | "skipped";
  exitCode?: number;
  durationMs: number;
  stdoutExcerpt?: string;
  stderrExcerpt?: string;
  diagnostics?: string;
}

export interface HvigorDeprecatedApiWarning {
  file: string;
  line: number;
  column: number;
  apiName: string;
  modulePath: string;
  moduleName: string;
  command: HvigorBuildCheckModuleResult["command"];
  message: string;
}

export interface HvigorBuildCheckSummary {
  enabled: boolean;
  status: HvigorBuildCheckStatus;
  buildCheckSource?: "remote" | "hvigor" | "agent";
  hvigorRunDir?: string;
  checkedModules: string[];
  moduleResults: HvigorBuildCheckModuleResult[];
  deprecatedApiWarnings?: HvigorDeprecatedApiWarning[];
  hardGateTriggered: boolean;
  scoreCap?: number;
  diagnostics?: string;
  durationMs: number;
  cleanup: {
    attempted: boolean;
    removedPaths: string[];
    failedPaths: Array<{ path: string; reason: string }>;
  };
}

export interface OfficialLinterResult {
  rule_id: string;
  rule_result_id: string;
  source_rule_set: string;
  severity: OfficialLinterFinding["severity"];
  result: "不满足";
  finding_count: number;
  findings: Array<{
    file: string;
    line?: number;
    column?: number;
    severity: OfficialLinterFinding["severity"];
    message: string;
  }>;
  conclusion: string;
  score_delta: number;
  affected_items: Array<{
    dimension_name: string;
    item_name: string;
    score_delta: number;
    reason: string;
  }>;
}

export interface StaticRuleAuditResult {
  rule_id: string;
  rule_summary?: string;
  rule_source: "must_rule" | "should_rule" | "forbidden_pattern";
  result: "满足" | "不满足" | "不涉及" | "未接入判定器";
  conclusion: string;
}

export interface RuleViolation {
  rule_source: string;
  rule_id: string;
  rule_summary: string;
  affected_items: string[];
  handling_result: string;
  evidence: string;
}

export type ConfidenceLevel = "high" | "medium" | "low";

// 以下结构基本直接映射到 `result.json` schema，保持命名一致以减少转换成本。
export interface DimensionScore {
  dimension_name: string;
  score: number;
  max_score: number;
  comment: string;
}

export interface SubmetricDetail {
  dimension_name: string;
  metric_name: string;
  score: number;
  confidence: ConfidenceLevel;
  review_required: boolean;
  rationale: string;
  evidence: string;
}

export interface RiskItem {
  id: number;
  level: string;
  title: string;
  description?: string;
  evidence?: string;
  risk_code?: string;
  risk_category?: "low" | "medium" | "high";
  source_rule_id?: string;
  score_effect?: Record<string, unknown>;
}

export interface HumanReviewItem {
  id: number;
  item: string;
  current_assessment: string;
  uncertainty_reason: string;
  suggested_focus: string;
  score_effect?: Record<string, unknown>;
}

export interface EvidenceSummary {
  workspaceFileCount: number;
  originalFileCount: number;
  changedFileCount: number;
  changedFiles: string[];
  changedLineNumbersByFile?: Record<string, number[]>;
  hasPatch: boolean;
}

export interface CaseRuleStaticPrecheck {
  target_matched: boolean;
  target_files: string[];
  matched_files?: string[];
  signal_status:
    | "all_matched"
    | "partial_matched"
    | "none_matched"
    | "no_target_files";
  matched_tokens: string[];
  summary: string;
}

export interface AssistedRuleReviewEvidence {
  rule_id: string;
  file: string;
  line?: number;
  subject: string;
  evidence: string;
  question: string;
}

// AssistedRuleCandidate 描述需要 Agent 辅助判定的弱规则候选及其证据。
export interface AssistedRuleCandidate {
  rule_id: string;
  rule_summary?: string;
  rule_source: "must_rule" | "should_rule" | "forbidden_pattern";
  why_uncertain: string;
  local_preliminary_signal: string;
  evidence_files: string[];
  evidence_snippets: string[];
  review_evidence?: AssistedRuleReviewEvidence;
  rule_name?: string;
  priority?: CaseConstraintPriority;
  kit?: string[];
  llm_prompt?: string;
  ast_signals?: Array<Record<string, string>>;
  target_checks?: Array<{
    target: string;
    ast_signals: Array<Record<string, string>>;
    llm_prompt: string;
  }>;
  decision_criteria?: RuleDecisionCriteria;
  static_precheck?: CaseRuleStaticPrecheck;
  is_case_rule?: boolean;
}

export interface AgentBootstrapStaticPrecheck {
  target_matched: boolean;
  signal_status: CaseRuleStaticPrecheck["signal_status"];
  matched_tokens?: string[];
  target_file_count?: number;
  representative_files?: string[];
}

export interface AgentBootstrapTargetCheck {
  target: string;
  ast_signals?: Array<Record<string, string>>;
  llm_prompt: string;
}

export interface AgentBootstrapRuleCandidate {
  rule_id: string;
  rule_name?: string;
  why_uncertain: string;
  evidence_files?: string[];
  review_evidence?: AssistedRuleReviewEvidence;
  kit?: string[];
  llm_prompt?: string;
  target_checks?: AgentBootstrapTargetCheck[];
  decision_criteria?: RuleDecisionCriteria;
  static_precheck?: AgentBootstrapStaticPrecheck;
}

export interface CaseRuleResult {
  rule_id: string;
  rule_name: string;
  priority: CaseConstraintPriority;
  rule_source: "must_rule" | "should_rule";
  result: "满足" | "不满足" | "不涉及" | "待人工复核";
  conclusion: string;
  hard_gate_triggered: boolean;
}

export type AgentRunStatus =
  | "not_enabled"
  | "success"
  | "failed"
  | "invalid_output"
  | "skipped";

// LoadedRubricSnapshot 是从 rubric 裁剪出的轻量快照，专供 prompt 构建与落盘。
export interface LoadedRubricSnapshot {
  task_type: TaskType;
  evaluation_mode: string;
  scenario: string;
  scoring_method: string;
  scoring_note: string;
  common_risks: string[];
  report_emphasis: string[];
  dimension_summaries: Array<{
    name: string;
    weight: number;
    intent: string;
    item_summaries: Array<{
      name: string;
      weight: number;
      scoring_bands: Array<{
        score: number;
        criteria: string;
      }>;
    }>;
  }>;
  hard_gates: Array<{
    id: string;
    score_cap: number;
  }>;
  review_rule_summary: string[];
  risk_taxonomy?: Array<{
    code: string;
    level: "low" | "medium" | "high";
    title: string;
    description: string;
  }>;
}

export interface AgentBootstrapPayload {
  case_context: {
    case_id: string;
    case_root: string;
    task_type: TaskType;
    original_prompt_summary: string;
    original_project_path: string;
    generated_project_path: string;
    effective_patch_path?: string;
  };
  task_understanding: ConstraintSummary;
  assisted_rule_candidates: AgentBootstrapRuleCandidate[];
}

export interface RubricScoringPayload {
  case_context: {
    case_id: string;
    case_root: string;
    task_type: TaskType;
    original_prompt_summary: string;
    original_project_path: string;
    generated_project_path: string;
    effective_patch_path?: string;
  };
  task_understanding: ConstraintSummary;
  rubric_summary: LoadedRubricSnapshot;
  workspace_project_structure?: ProjectStructureSummary;
  workspace_project_structure_note?: string;
  response_contract: {
    output_language: "zh-CN";
    json_only: true;
    required_top_level_fields?: [
      "summary",
      "item_scores",
      "hard_gate_candidates",
      "risks",
      "strengths",
      "main_issues",
    ];
  };
}

export interface RubricDeductionTrace {
  code_locations: string[];
  impact_scope: string;
  rubric_comparison: string;
  deduction_reason: string;
  improvement_suggestion: string;
}

export interface RubricScoringItemScore {
  dimension_name: string;
  item_name: string;
  score: number;
  max_score: number;
  matched_band_score: number;
  rationale: string;
  evidence_used: string[];
  confidence: ConfidenceLevel;
  review_required: boolean;
  deduction_trace?: RubricDeductionTrace;
}

export interface RubricScoringResult {
  summary: {
    overall_assessment: string;
    overall_confidence: ConfidenceLevel;
  };
  item_scores: RubricScoringItemScore[];
  hard_gate_candidates: Array<{
    gate_id: "G1" | "G2" | "G3" | "G4";
    triggered: boolean;
    reason: string;
    confidence: ConfidenceLevel;
  }>;
  risks: RiskItem[];
  strengths: string[];
  main_issues: string[];
}

export interface AgentRuleAssessment {
  rule_id: string;
  decision: "violation" | "pass" | "not_applicable" | "uncertain";
  confidence: ConfidenceLevel;
  reason: string;
  evidence_used: string[];
  needs_human_review: boolean;
}

export interface AgentAssistedRuleResult {
  summary: {
    assistant_scope: string;
    overall_confidence: ConfidenceLevel;
  };
  rule_assessments: AgentRuleAssessment[];
}

export interface OpencodeRuleRunnerResult {
  outcome: "success" | "request_failed" | "protocol_error";
  final_answer?: AgentAssistedRuleResult;
  final_answer_raw_text?: string;
  raw_events?: string;
  failure_reason?: string;
}

export interface OpencodeRubricRunnerResult {
  outcome: "success" | "request_failed" | "protocol_error";
  final_answer?: RubricScoringResult;
  final_answer_raw_text?: string;
  raw_events?: string;
  failure_reason?: string;
}

export type RuleImpactSeverity =
  | "review_only"
  | "light"
  | "medium"
  | "heavy"
  | "gating";

export interface RuleImpactDetail {
  rule_id: string;
  rule_source: "must_rule" | "should_rule" | "forbidden_pattern";
  result: "不满足" | "待人工复核";
  severity: RuleImpactSeverity;
  score_delta: number;
  agent_assisted: boolean;
  needs_human_review: boolean;
}

export interface ScoreFusionDetail {
  dimension_name: string;
  item_name: string;
  agent_evaluation: {
    base_score: number;
    matched_band_score: number;
    matched_criteria: string;
    logic: string;
    evidence_used: string[];
    confidence: ConfidenceLevel;
    deduction_trace: RubricDeductionTrace | null;
  };
  rule_impacts: RuleImpactDetail[];
  score_fusion: {
    base_score: number;
    rule_delta: number;
    final_score: number;
    fusion_logic: string;
  };
}

export type RuleEvidenceIndex = Record<
  string,
  {
    evidenceFiles: string[];
    evidenceSnippets: string[];
  }
>;

export interface ScoreComputation {
  totalScore: number;
  hardGateTriggered: boolean;
  hardGateReason?: string;
  overallConclusion: {
    total_score: number;
    pre_cap_score: number;
    hard_gate_triggered: boolean;
    hard_gates: Array<Record<string, unknown>>;
    summary: string;
  };
  dimensionScores: DimensionScore[];
  submetricDetails: SubmetricDetail[];
  scoreFusionDetails: ScoreFusionDetail[];
  risks: RiskItem[];
  humanReviewItems: HumanReviewItem[];
  strengths: string[];
  mainIssues: string[];
  finalRecommendation: string[];
}

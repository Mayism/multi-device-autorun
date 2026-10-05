import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { collectEvidence } from "../evidence/collectEvidence.js";
import {
  defaultEnabledRulePackIds,
  getEnabledRulePacks,
  listRegisteredRules,
} from "../registry/rulePackRegistry.js";
import type {
  AssistedRuleCandidate,
  CaseInput,
  CaseRuleDefinition,
  EvidenceSummary,
  RuleAuditResult,
  RuleEvidenceIndex,
  RuleViolation,
  StaticRuleAuditResult,
  TaskType,
} from "../../types.js";
import { mapAssistedRuleCandidate } from "./assistedRuleMapper.js";
import { evaluateRegisteredRule } from "./evaluationDispatcher.js";
import { buildRuleEvidenceIndex, getRuleEvidenceFiles } from "./evidenceIndex.js";

// Rule engine 的输出会被 workflow 直接写盘并送入 scoring engine。
export interface RuleEngineOutput {
  staticRuleAuditResults: StaticRuleAuditResult[];
  deterministicRuleResults: RuleAuditResult[];
  caseRuleResults: RuleAuditResult[];
  assistedRuleCandidates: AssistedRuleCandidate[];
  ruleViolations: RuleViolation[];
  enabledRulePacks: Array<{ pack_id: string; display_name: string; version?: string }>;
  ruleEvidenceIndex: RuleEvidenceIndex;
  evidenceSummary: EvidenceSummary;
}

type DeterministicStaticRuleAuditResult = StaticRuleAuditResult & {
  result: Exclude<StaticRuleAuditResult["result"], "未接入判定器">;
};

function isDeterministicStaticRule(
  rule: StaticRuleAuditResult,
): rule is DeterministicStaticRuleAuditResult {
  return rule.result !== "未接入判定器";
}

function runPythonRuleCli<T>(mode: "evaluate" | "assemble" | "evidence", payload: unknown): T {
  const exchangeDir = mkdtempSync(path.join(tmpdir(), "whitebox-rules-"));
  try {
    const inputPath = path.join(exchangeDir, "input.json");
    const outputPath = path.join(exchangeDir, "output.json");
    writeFileSync(inputPath, JSON.stringify(payload), "utf8");
    const python = process.env.HMOS_WHITEBOX_PYTHON_EXECUTABLE || "python3";
    const run = spawnSync(python, ["-m", "pyautorun.whitebox_rule_cli", "--mode", mode,
      "--input", inputPath, "--output", outputPath], {
      encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30_000, env: process.env,
    });
    if (run.error || run.status !== 0) {
      throw new Error(`Python 白盒规则${mode}执行失败: ${run.error?.message ?? run.stderr}`);
    }
    return JSON.parse(readFileSync(outputPath, "utf8")) as T;
  } finally {
    rmSync(exchangeDir, { recursive: true, force: true });
  }
}

function usePythonEvidence(
  caseInput: CaseInput,
  nodeEvidence: Awaited<ReturnType<typeof collectEvidence>>,
): Awaited<ReturnType<typeof collectEvidence>> {
  if (process.env.HMOS_WHITEBOX_PYTHON_RULES_ENABLE !== "true") return nodeEvidence;
  const { arkFacts, ...nodeText } = nodeEvidence;
  const pythonText = runPythonRuleCli<typeof nodeText>("evidence", { caseInput });
  const comparison = JSON.parse(JSON.stringify(nodeText)) as typeof nodeText;
  if (!isDeepStrictEqual(pythonText, comparison)) {
    const field = Object.keys(comparison).find((key) => !isDeepStrictEqual(
      (pythonText as unknown as Record<string, unknown>)[key],
      (comparison as unknown as Record<string, unknown>)[key],
    ));
    throw new Error(`Python 与 Node 白盒规则证据不一致: ${field ?? "字段集"}`);
  }
  return { ...pythonText, ...(arkFacts ? { arkFacts } : {}) };
}

function usePythonSelectedRules(
  rules: ReturnType<typeof listRegisteredRules>,
  evidence: Awaited<ReturnType<typeof collectEvidence>>,
  nodeResults: ReturnType<typeof evaluateRegisteredRule>[],
): ReturnType<typeof evaluateRegisteredRule>[] {
  if (process.env.HMOS_WHITEBOX_PYTHON_RULES_ENABLE !== "true") return nodeResults;
  const selected = rules.map((rule, index) => ({ rule, index })).filter(
    ({ rule }) => rule.detector.kind === "static" &&
      (rule.detector.mode === "regex" || rule.detector.mode === "project_structure" ||
        rule.detector.mode === "case_constraint_precheck"),
  );
  if (selected.length === 0) return nodeResults;
  const pythonResults = runPythonRuleCli<ReturnType<typeof evaluateRegisteredRule>[]>("evaluate", {
    rules: selected.map(({ rule }) => rule),
    evidence: { workspaceFiles: evidence.workspaceFiles },
  });
  if (pythonResults.length !== selected.length) {
    throw new Error("Python 白盒规则结果数量不一致");
  }
  const results = [...nodeResults];
  for (let index = 0; index < selected.length; index += 1) {
    const { rule, index: resultIndex } = selected[index];
    if (!isDeepStrictEqual(pythonResults[index], JSON.parse(JSON.stringify(nodeResults[resultIndex])))) {
      throw new Error(`Python 与 Node 白盒规则结果不一致: ${rule.rule_id}`);
    }
    results[resultIndex] = pythonResults[index];
  }
  return results;
}

function usePythonRuleAssembly(
  nodeResult: RuleEngineOutput,
  payload: unknown,
): RuleEngineOutput {
  if (process.env.HMOS_WHITEBOX_PYTHON_RULES_ENABLE !== "true") return nodeResult;
  const pythonResult = runPythonRuleCli<RuleEngineOutput>("assemble", payload);
  if (!isDeepStrictEqual(pythonResult, JSON.parse(JSON.stringify(nodeResult)))) {
    const field = Object.keys(nodeResult).find((key) => !isDeepStrictEqual(
      (pythonResult as unknown as Record<string, unknown>)[key],
      (nodeResult as unknown as Record<string, unknown>)[key],
    ));
    throw new Error(`Python 与 Node 白盒规则汇总结果不一致: ${field ?? "字段集"}`);
  }
  return pythonResult;
}

export async function runRuleEngine(input: {
  referenceRoot: string;
  caseInput: CaseInput;
  taskType: TaskType;
  runtimeRules?: CaseRuleDefinition[];
  enabledRulePackIds?: string[];
}): Promise<RuleEngineOutput> {
  void input.referenceRoot;
  const nodeEvidence = await collectEvidence(input.caseInput, { taskType: input.taskType });
  const evidence = usePythonEvidence(input.caseInput, nodeEvidence);
  const enabledRulePacks = input.enabledRulePackIds
    ? getEnabledRulePacks(input.enabledRulePackIds)
    : getEnabledRulePacks([...defaultEnabledRulePackIds]);
  const registeredRules = listRegisteredRules({
    enabledPackIds: enabledRulePacks.map((pack) => pack.packId),
    runtimeRules: input.runtimeRules ?? [],
  });
  const ruleSummaryById = new Map(registeredRules.map((rule) => [rule.rule_id, rule.summary]));
  const registeredRuleById = new Map(registeredRules.map((rule) => [rule.rule_id, rule]));
  const nodeEvaluatedRules = registeredRules.map((rule) => evaluateRegisteredRule(rule, evidence));
  const evaluatedRules = usePythonSelectedRules(registeredRules, evidence, nodeEvaluatedRules);
  const evaluatedRuleById = new Map(evaluatedRules.map((rule) => [rule.rule_id, rule]));
  const caseRuleIds = new Set((input.runtimeRules ?? []).map((rule) => rule.rule_id));

  const ruleViolations: RuleViolation[] = evaluatedRules
    .filter((rule) => rule.result === "不满足")
    .map((rule) => ({
      rule_source: rule.rule_source,
      rule_id: rule.rule_id,
      rule_summary: rule.conclusion,
      affected_items: getRuleEvidenceFiles(rule),
      handling_result: "待人工复核",
      evidence: rule.conclusion,
    }));

  const ruleEvidenceIndex = buildRuleEvidenceIndex(evaluatedRules, evidence);

  const staticRuleAuditResults: StaticRuleAuditResult[] = evaluatedRules.map(
    ({
      matchedFiles: _matchedFiles,
      matchedLocations: _matchedLocations,
      matchedSnippets: _matchedSnippets,
      ...rule
    }) => {
      const normalizedRule = {
        ...rule,
        rule_summary: rule.rule_summary ?? ruleSummaryById.get(rule.rule_id) ?? "",
      };
      if (caseRuleIds.has(rule.rule_id)) {
        return normalizedRule;
      }
      return normalizedRule;
    },
  );
  const deterministicRuleResults: RuleAuditResult[] = staticRuleAuditResults
    .filter(isDeterministicStaticRule)
    .filter((rule) => !caseRuleIds.has(rule.rule_id))
    .map((rule) => ({
      rule_id: rule.rule_id,
      rule_summary: rule.rule_summary,
      rule_source: rule.rule_source,
      result: rule.result,
      conclusion: rule.conclusion,
    }));
  const caseRuleResults: RuleAuditResult[] = [];
  const assistedRuleCandidates: AssistedRuleCandidate[] = staticRuleAuditResults
    .filter((rule) => rule.result === "未接入判定器" || caseRuleIds.has(rule.rule_id))
    .map((rule) =>
      mapAssistedRuleCandidate({
        rule,
        registeredRule: registeredRuleById.get(rule.rule_id),
        evaluatedRule: evaluatedRuleById.get(rule.rule_id),
        ruleEvidenceIndex,
      }),
    );

  const nodeResult: RuleEngineOutput = {
    staticRuleAuditResults,
    deterministicRuleResults,
    caseRuleResults,
    assistedRuleCandidates,
    ruleViolations,
    enabledRulePacks: enabledRulePacks.map((pack) => ({
      pack_id: pack.packId,
      display_name: pack.displayName,
      ...(pack.version ? { version: pack.version } : {}),
    })),
    ruleEvidenceIndex,
    evidenceSummary: evidence.summary,
  };
  return usePythonRuleAssembly(nodeResult, {
    registeredRules,
    evaluatedRules,
    runtimeRules: input.runtimeRules ?? [],
    enabledRulePacks,
    evidence: {
      workspaceFiles: evidence.workspaceFiles,
      changedFiles: evidence.changedFiles,
      summary: evidence.summary,
    },
  });
}

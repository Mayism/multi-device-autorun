import fs from "node:fs/promises";
import path from "node:path";
import type { RemoteTaskRecord, RemoteTaskRegistry } from "../../api/remoteTaskRegistry.js";
import {
  crossDeviceAdaptationRulePackId,
  getRegisteredRulePacks,
} from "../../rules/registry/rulePackRegistry.js";
import { statusCategory, readRiskReviewCalibrationDataset } from "./dashboardDataStore.js";
import type {
  CrossDeviceBoundRulePack,
  CrossDeviceRelatedTask,
  CrossDeviceRiskReviewItem,
  CrossDeviceRuleAuditCounts,
  CrossDeviceRuleAuditResult,
} from "./crossDeviceTypes.js";

const CROSS_DEVICE_RULE_SET = "plugin:@cross-device-app-dev/recommended";

const rulePackDisplayNameById = new Map(
  getRegisteredRulePacks().map((pack) => [pack.packId, pack.displayName] as const),
);
const rulePackIdByRuleId = new Map<string, string>(
  getRegisteredRulePacks().flatMap((pack) =>
    pack.rules.map((rule) => [rule.rule_id, pack.packId] as const),
  ),
);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readScore(resultJson: Record<string, unknown> | undefined): number | null {
  const overall = asRecord(resultJson?.overall_conclusion);
  const score = overall?.total_score;
  return typeof score === "number" && Number.isFinite(score) ? score : null;
}

function readHardGate(resultJson: Record<string, unknown> | undefined): boolean | null {
  const overall = asRecord(resultJson?.overall_conclusion);
  return typeof overall?.hard_gate_triggered === "boolean" ? overall.hard_gate_triggered : null;
}

function readCaseName(resultJson: Record<string, unknown> | undefined): string | undefined {
  const basicInfo = asRecord(resultJson?.basic_info);
  return readString(basicInfo, "case_name") ?? readString(basicInfo, "name");
}

function readTaskType(resultJson: Record<string, unknown> | undefined): string | undefined {
  const basicInfo = asRecord(resultJson?.basic_info);
  return readString(basicInfo, "task_type");
}

function readCrossDeviceReasons(
  constraintSummary: Record<string, unknown> | undefined,
): string[] | undefined {
  const crossDeviceAdaptation = asRecord(constraintSummary?.crossDeviceAdaptation);
  if (crossDeviceAdaptation?.applicability !== "involved") {
    return undefined;
  }
  const reasons = crossDeviceAdaptation.reasons;
  return Array.isArray(reasons)
    ? reasons.filter((reason): reason is string => typeof reason === "string" && reason.length > 0)
    : [];
}

async function readCrossDeviceConstraintSummary(
  caseDir: string,
): Promise<Record<string, unknown> | undefined> {
  const metadata = await readJsonFile(
    path.join(caseDir, "opencode-sandbox", "metadata", "metadata.json"),
  );
  const metadataConstraintSummary = asRecord(metadata?.constraint_summary);
  if (metadataConstraintSummary) {
    return metadataConstraintSummary;
  }

  return readJsonFile(path.join(caseDir, "intermediate", "constraint-summary.json"));
}

function readRisks(resultJson: Record<string, unknown> | undefined) {
  const risks = resultJson?.risks;
  if (!Array.isArray(risks)) {
    return [];
  }
  return risks
    .map((risk): { level?: string; title?: string } | undefined => {
      const record = asRecord(risk);
      if (!record) {
        return undefined;
      }
      return {
        level: readString(record, "level"),
        title: readString(record, "title"),
      };
    })
    .filter((risk): risk is { level?: string; title?: string } => Boolean(risk));
}

function readOfficialLinterRunStatus(
  resultJson: Record<string, unknown> | undefined,
): string | undefined {
  return readString(asRecord(resultJson?.official_linter_summary), "runStatus");
}

function readCrossDeviceRuleSetApplied(resultJson: Record<string, unknown> | undefined): boolean {
  const configuredRuleSets = asRecord(resultJson?.official_linter_summary)?.configuredRuleSets;
  return Array.isArray(configuredRuleSets) && configuredRuleSets.includes(CROSS_DEVICE_RULE_SET);
}

function readBoundRulePacks(
  resultJson: Record<string, unknown> | undefined,
): CrossDeviceBoundRulePack[] {
  const packs = resultJson?.bound_rule_packs;
  if (!Array.isArray(packs)) {
    return [];
  }
  return packs
    .map((item) => {
      const record = asRecord(item);
      const packId = readString(record, "pack_id");
      if (!packId) {
        return undefined;
      }
      return {
        packId,
        displayName:
          readString(record, "display_name") ?? rulePackDisplayNameById.get(packId) ?? packId,
      };
    })
    .filter((item): item is CrossDeviceBoundRulePack => Boolean(item));
}

function readOfficialLinterResults(resultJson: Record<string, unknown> | undefined) {
  const results = resultJson?.official_linter_results;
  if (Array.isArray(results)) {
    return results
      .map((item) => {
        const record = asRecord(item);
        const ruleId = readString(record, "rule_id");
        if (!record || !ruleId) {
          return undefined;
        }
        const findingCount = record.finding_count;
        return {
          ruleId,
          ruleResultId: readString(record, "rule_result_id"),
          sourceRuleSet: readString(record, "source_rule_set"),
          severity: readString(record, "severity"),
          findingCount:
            typeof findingCount === "number" && Number.isFinite(findingCount) ? findingCount : 1,
          conclusion: readString(record, "conclusion"),
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  }

  const ruleAuditResults = resultJson?.rule_audit_results;
  if (!Array.isArray(ruleAuditResults)) {
    return [];
  }
  return ruleAuditResults
    .map((item) => {
      const record = asRecord(item);
      const ruleId = readString(record, "rule_id");
      if (!record || !ruleId?.startsWith("OFFICIAL-LINTER:")) {
        return undefined;
      }
      const findingCount = record.finding_count;
      const findings = Array.isArray(record.findings)
        ? record.findings.map((finding) => asRecord(finding))
        : [];
      return {
        ruleId: ruleId.replace(/^OFFICIAL-LINTER:/, ""),
        ruleResultId: ruleId,
        sourceRuleSet: CROSS_DEVICE_RULE_SET,
        severity: readString(findings[0], "severity"),
        findingCount:
          typeof findingCount === "number" && Number.isFinite(findingCount) ? findingCount : 1,
        conclusion: readString(record, "conclusion"),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function isCrossDeviceOfficialRule(rule: { ruleId: string; sourceRuleSet?: string }): boolean {
  return (
    rule.sourceRuleSet === CROSS_DEVICE_RULE_SET || rule.ruleId.startsWith("@cross-device-app-dev/")
  );
}

function readRuleAuditResults(resultJson: Record<string, unknown> | undefined) {
  const results = resultJson?.rule_audit_results;
  if (!Array.isArray(results)) {
    return [];
  }
  return results
    .map((item) => {
      const record = asRecord(item);
      const ruleId = readString(record, "rule_id");
      if (!record || !ruleId) {
        return undefined;
      }
      const packId = rulePackIdByRuleId.get(ruleId);
      return {
        packId,
        packDisplayName: packId ? rulePackDisplayNameById.get(packId) : undefined,
        ruleId,
        ruleSummary: readString(record, "rule_summary"),
        ruleSource: readString(record, "rule_source"),
        result: readString(record, "result"),
        conclusion: readString(record, "conclusion"),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function filterCrossDeviceRuleAuditResults(
  ruleAuditResults: CrossDeviceRuleAuditResult[],
): CrossDeviceRuleAuditResult[] {
  return ruleAuditResults.filter((rule) => rule.packId === crossDeviceAdaptationRulePackId);
}

function buildRuleAuditCounts(
  ruleAuditResults: CrossDeviceRuleAuditResult[],
): CrossDeviceRuleAuditCounts {
  return {
    violated: ruleAuditResults.filter((rule) => rule.result === "不满足").length,
    review: ruleAuditResults.filter((rule) => rule.result === "待人工复核").length,
    satisfied: ruleAuditResults.filter((rule) => rule.result === "满足").length,
    notInvolved: ruleAuditResults.filter((rule) => rule.result === "不涉及").length,
    total: ruleAuditResults.length,
  };
}

function buildTopCrossDeviceRules(
  officialLinterResults: ReturnType<typeof readOfficialLinterResults>,
) {
  return officialLinterResults
    .filter(isCrossDeviceOfficialRule)
    .map((result) => ({
      ruleId: result.ruleId,
      sourceRuleSet: result.sourceRuleSet ?? "",
      findingCount: result.findingCount,
    }))
    .sort((left, right) => right.findingCount - left.findingCount)
    .slice(0, 5);
}

function buildRiskLevelCounts(risks: Array<{ level?: string }>) {
  const counts = new Map<string, number>();
  for (const risk of risks) {
    if (risk.level) {
      counts.set(risk.level, (counts.get(risk.level) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries()).map(([level, count]) => ({ level, count }));
}

async function readCrossDeviceTask(
  record: RemoteTaskRecord,
): Promise<CrossDeviceRelatedTask | undefined> {
  if (!record.caseDir) {
    return undefined;
  }
  const constraintSummary = await readCrossDeviceConstraintSummary(record.caseDir);
  const resultJson = await readJsonFile(path.join(record.caseDir, "outputs", "result.json"));
  const reasons = readCrossDeviceReasons(constraintSummary);
  if (!reasons) {
    return undefined;
  }

  const caseInfo = await readJsonFile(path.join(record.caseDir, "inputs", "case-info.json"));
  const name =
    readCaseName(resultJson) ??
    readString(caseInfo, "remote_test_case_name") ??
    readString(caseInfo, "test_case_name") ??
    readString(caseInfo, "case_name") ??
    record.testCaseName ??
    `Task ${String(record.taskId)}`;
  const taskType =
    readTaskType(resultJson) ??
    readString(caseInfo, "remote_test_case_type") ??
    readString(caseInfo, "task_type") ??
    record.testCaseType ??
    "unknown";
  const risks = readRisks(resultJson);
  const officialLinterResults = readOfficialLinterResults(resultJson);
  const crossDeviceOfficialLinterResults = officialLinterResults.filter(isCrossDeviceOfficialRule);
  const ruleAuditResults = readRuleAuditResults(resultJson);
  const crossDeviceRuleAuditResults = filterCrossDeviceRuleAuditResults(ruleAuditResults);
  const topRuleViolations = buildTopCrossDeviceRules(officialLinterResults);

  return {
    taskId: record.taskId,
    testCaseId: record.testCaseId,
    name,
    status: record.status,
    statusCategory: statusCategory(record.status),
    taskType,
    score: readScore(resultJson),
    hardGateTriggered: readHardGate(resultJson),
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
    resultAvailable: Boolean(resultJson),
    reasons,
    officialLinterRunStatus: readOfficialLinterRunStatus(resultJson),
    crossDeviceRuleSetApplied: readCrossDeviceRuleSetApplied(resultJson),
    crossDeviceFindingCount: topRuleViolations.reduce((sum, rule) => sum + rule.findingCount, 0),
    riskCount: risks.length,
    boundRulePacks: readBoundRulePacks(resultJson),
    crossDeviceRuleAuditCounts: buildRuleAuditCounts(crossDeviceRuleAuditResults),
    crossDeviceRuleAuditResults,
    crossDeviceOfficialLinterResults,
    topRuleViolations,
    riskLevelCounts: buildRiskLevelCounts(risks),
    risks,
    officialLinterResults,
    ruleAuditResults,
  };
}

export async function listCrossDeviceRelatedTasks(
  registry: RemoteTaskRegistry,
): Promise<CrossDeviceRelatedTask[]> {
  const records = await registry.list();
  const tasks = await Promise.all(records.map((record) => readCrossDeviceTask(record)));
  return tasks.filter((task): task is CrossDeviceRelatedTask => Boolean(task));
}

export async function readCrossDeviceRiskReviewDataset(input: {
  root: string;
  relatedTaskIds: Set<number>;
  taskNames: Map<number, string>;
}): Promise<{ items: CrossDeviceRiskReviewItem[]; skippedRows: number }> {
  const dataset = await readRiskReviewCalibrationDataset(input.root, input.taskNames);
  return {
    skippedRows: dataset.skippedRows,
    items: dataset.items.filter((item) => input.relatedTaskIds.has(item.taskId)),
  };
}

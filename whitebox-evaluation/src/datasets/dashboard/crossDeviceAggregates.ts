import type {
  CrossDeviceCaseQuery,
  CrossDeviceRelatedTask,
  CrossDeviceRiskReviewItem,
  CrossDeviceRiskReviewQuery,
  CrossDeviceRuleViolationQuery,
} from "./crossDeviceTypes.js";
import { getRegisteredRulePacks } from "../../rules/registry/rulePackRegistry.js";

const CROSS_DEVICE_CONDITIONAL_RULE_PACK_ID = "cross-device-adaptation";

const rulePackIdByRuleId = new Map<string, string>(
  getRegisteredRulePacks().flatMap((pack) =>
    pack.rules.map((rule) => [rule.rule_id, pack.packId] as const),
  ),
);

function matchesKeyword(
  item: { taskId?: number; testCaseId?: number; name?: string; caseName?: string },
  keyword?: string,
): boolean {
  const normalized = keyword?.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return [
    String(item.taskId ?? ""),
    String(item.testCaseId ?? ""),
    item.name ?? item.caseName ?? "",
  ]
    .join(" ")
    .toLowerCase()
    .includes(normalized);
}

function matchesDateRange(task: CrossDeviceRelatedTask, from?: string, to?: string): boolean {
  const updatedAt = Date.parse(task.updatedAt);
  if (from && updatedAt < Date.parse(from)) {
    return false;
  }
  if (to && updatedAt > Date.parse(to)) {
    return false;
  }
  return true;
}

export function filterCrossDeviceCases(
  tasks: CrossDeviceRelatedTask[],
  query: CrossDeviceCaseQuery,
): CrossDeviceRelatedTask[] {
  return tasks
    .filter((task) => matchesKeyword(task, query.keyword))
    .filter((task) => matchesDateRange(task, query.from, query.to))
    .filter((task) => (query.taskType ? task.taskType === query.taskType : true))
    .filter((task) =>
      query.scoreMin !== undefined && task.score !== null
        ? task.score >= query.scoreMin
        : query.scoreMin === undefined,
    )
    .filter((task) =>
      query.scoreMax !== undefined && task.score !== null
        ? task.score <= query.scoreMax
        : query.scoreMax === undefined,
    );
}

export function sortCrossDeviceCases(
  tasks: CrossDeviceRelatedTask[],
  query: Pick<CrossDeviceCaseQuery, "sortBy" | "sortOrder">,
): CrossDeviceRelatedTask[] {
  const direction = query.sortOrder === "asc" ? 1 : -1;
  return [...tasks].sort((left, right) => {
    const leftValue = query.sortBy === "score" ? (left.score ?? -Infinity) : left[query.sortBy];
    const rightValue = query.sortBy === "score" ? (right.score ?? -Infinity) : right[query.sortBy];
    if (typeof leftValue === "number" && typeof rightValue === "number") {
      return (leftValue - rightValue) * direction;
    }
    return String(leftValue).localeCompare(String(rightValue)) * direction;
  });
}

function matchesRuleKeyword(
  rule: { ruleId: string; ruleSummary?: string },
  keyword?: string,
): boolean {
  const normalized = keyword?.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return [rule.ruleId, rule.ruleSummary ?? ""].join(" ").toLowerCase().includes(normalized);
}

function isOfficialLinterMirrorRule(ruleId: string): boolean {
  return ruleId.startsWith("OFFICIAL-LINTER:");
}

function isCrossDeviceConditionalRule(ruleId: string): boolean {
  return rulePackIdByRuleId.get(ruleId) === CROSS_DEVICE_CONDITIONAL_RULE_PACK_ID;
}

export function buildCrossDeviceRuleViolationStats(
  tasks: CrossDeviceRelatedTask[],
  query: CrossDeviceRuleViolationQuery,
) {
  const stats = new Map<
    string,
    {
      ruleId: string;
      ruleSummary?: string;
      sourceRuleSet?: string;
      severity?: string;
      violationCount: number;
      affectedTaskIds: Set<number>;
      lastViolatedAt: string;
    }
  >();

  for (const task of tasks) {
    for (const rule of task.ruleAuditResults) {
      if (
        rule.result !== "不满足" ||
        isOfficialLinterMirrorRule(rule.ruleId) ||
        (!query.includeOtherRules && !isCrossDeviceConditionalRule(rule.ruleId))
      ) {
        continue;
      }
      const existing = stats.get(rule.ruleId) ?? {
        ruleId: rule.ruleId,
        ruleSummary: rule.ruleSummary,
        sourceRuleSet: rule.ruleSource,
        violationCount: 0,
        affectedTaskIds: new Set<number>(),
        lastViolatedAt: task.updatedAt,
      };
      existing.violationCount += 1;
      existing.affectedTaskIds.add(task.taskId);
      if (Date.parse(task.updatedAt) > Date.parse(existing.lastViolatedAt)) {
        existing.lastViolatedAt = task.updatedAt;
      }
      stats.set(rule.ruleId, existing);
    }
  }

  const items = Array.from(stats.values())
    .map((rule) => ({
      ruleId: rule.ruleId,
      ruleSummary: rule.ruleSummary,
      sourceRuleSet: rule.sourceRuleSet,
      severity: rule.severity,
      violationCount: rule.violationCount,
      affectedTaskCount: rule.affectedTaskIds.size,
      affectedTaskIds: Array.from(rule.affectedTaskIds).sort((left, right) => left - right),
      lastViolatedAt: rule.lastViolatedAt,
    }))
    .filter((rule) => matchesRuleKeyword(rule, query.keyword))
    .sort(
      (left, right) =>
        right.violationCount - left.violationCount || left.ruleId.localeCompare(right.ruleId),
    );

  return {
    summary: {
      relatedCaseCount: tasks.length,
      violatedRuleCount: items.length,
      totalViolationEvents: items.reduce((sum, item) => sum + item.violationCount, 0),
    },
    items,
  };
}

function readAgreement(review: Record<string, unknown> | undefined): boolean | null {
  const agreed = review?.agreeWithResultLevel ?? review?.agree;
  return typeof agreed === "boolean" ? agreed : null;
}

export function filterCrossDeviceRiskReviews(
  items: CrossDeviceRiskReviewItem[],
  query: CrossDeviceRiskReviewQuery,
) {
  return items
    .filter((item) => matchesKeyword(item, query.keyword))
    .filter((item) => {
      if (!query.agreement) {
        return true;
      }
      const agreed = readAgreement(item.humanReview);
      return query.agreement === "agreed" ? agreed === true : agreed === false;
    })
    .filter((item) => {
      if (!query.riskLevel) {
        return true;
      }
      return item.resultRisk?.level === query.riskLevel;
    });
}

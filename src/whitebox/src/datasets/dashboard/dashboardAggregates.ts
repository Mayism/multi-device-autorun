import type { RuleViolationRunSnapshot } from "../../api/ruleViolationStatsStore.js";
import type {
  DashboardStatusCategory,
  DashboardTaskSummary,
  HumanRatingGapDashboardItem,
  ManualAnalysisStatus,
  RiskReviewCalibrationDashboardItem,
} from "./dashboardTypes.js";

type TaskQuery = {
  status?: DashboardStatusCategory;
  taskType?: string;
  keyword?: string;
  scoreMin?: number;
  scoreMax?: number;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
  sortBy: "createdAt" | "updatedAt" | "score" | "taskId";
  sortOrder: "asc" | "desc";
};

export function paginate<T>(
  items: T[],
  page: number,
  pageSize: number,
): { items: T[]; total: number } {
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    total: items.length,
  };
}

export function buildStatusCounts(tasks: DashboardTaskSummary[]) {
  const counts: Record<DashboardStatusCategory, number> = {
    received: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
  };
  for (const task of tasks) {
    counts[task.statusCategory] += 1;
  }
  return counts;
}

export function buildTaskTypeCounts(tasks: DashboardTaskSummary[]) {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    counts.set(task.taskType, (counts.get(task.taskType) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([taskType, count]) => ({ taskType, count }));
}

export function buildScoreSummary(tasks: DashboardTaskSummary[]) {
  const scores = tasks
    .filter((task) => task.statusCategory === "completed")
    .map((task) => task.score)
    .filter((score): score is number => typeof score === "number" && Number.isFinite(score));
  if (scores.length === 0) {
    return { completedWithScore: 0, averageScore: null, minScore: null, maxScore: null };
  }
  return {
    completedWithScore: scores.length,
    averageScore: Number(
      (scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(2),
    ),
    minScore: Math.min(...scores),
    maxScore: Math.max(...scores),
  };
}

function matchesDateRange(task: DashboardTaskSummary, from?: string, to?: string): boolean {
  const createdAt = Date.parse(task.createdAt);
  if (from !== undefined && createdAt < Date.parse(from)) {
    return false;
  }
  if (to !== undefined && createdAt > Date.parse(to)) {
    return false;
  }
  return true;
}

export function filterTasks(
  tasks: DashboardTaskSummary[],
  query: TaskQuery,
): DashboardTaskSummary[] {
  const keyword = query.keyword?.trim().toLowerCase();
  return tasks
    .filter((task) => (query.status ? task.statusCategory === query.status : true))
    .filter((task) => (query.taskType ? task.taskType === query.taskType : true))
    .filter((task) => matchesDateRange(task, query.from, query.to))
    .filter((task) =>
      query.scoreMin !== undefined && task.score !== null
        ? task.score >= query.scoreMin
        : query.scoreMin === undefined,
    )
    .filter((task) =>
      query.scoreMax !== undefined && task.score !== null
        ? task.score <= query.scoreMax
        : query.scoreMax === undefined,
    )
    .filter((task) => {
      if (!keyword) {
        return true;
      }
      return [String(task.taskId), String(task.testCaseId ?? ""), task.name]
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    })
    .sort((left, right) => {
      const direction = query.sortOrder === "asc" ? 1 : -1;
      const leftValue = query.sortBy === "score" ? (left.score ?? -Infinity) : left[query.sortBy];
      const rightValue =
        query.sortBy === "score" ? (right.score ?? -Infinity) : right[query.sortBy];
      if (typeof leftValue === "number" && typeof rightValue === "number") {
        return (leftValue - rightValue) * direction;
      }
      return String(leftValue).localeCompare(String(rightValue)) * direction;
    });
}

export function filterHumanRatingGaps(
  gaps: HumanRatingGapDashboardItem[],
  query: {
    from?: string;
    to?: string;
    manualRating?: string;
    primaryConclusion?: string;
    keyword?: string;
    manualAnalysisStatus?: ManualAnalysisStatus;
  },
) {
  const keyword = query.keyword?.trim().toLowerCase();
  return gaps.filter((gap) => {
    if (!matchesDashboardAnalysisKeyword(gap, keyword)) {
      return false;
    }
    if (query.manualRating && gap.manualRating !== query.manualRating) {
      return false;
    }
    if (query.primaryConclusion && gap.primaryConclusion !== query.primaryConclusion) {
      return false;
    }
    if (query.manualAnalysisStatus && gap.manualAnalysisStatus !== query.manualAnalysisStatus) {
      return false;
    }
    if (query.from && (!gap.reviewedAt || Date.parse(gap.reviewedAt) < Date.parse(query.from))) {
      return false;
    }
    if (query.to && (!gap.reviewedAt || Date.parse(gap.reviewedAt) > Date.parse(query.to))) {
      return false;
    }
    return true;
  });
}

function matchesDashboardAnalysisKeyword(
  item: { taskId: number; testCaseId?: number; caseName?: string; riskTitle?: string },
  keyword?: string,
): boolean {
  if (!keyword) {
    return true;
  }
  return [
    String(item.taskId),
    String(item.testCaseId ?? ""),
    item.caseName ?? "",
    item.riskTitle ?? "",
  ]
    .join(" ")
    .toLowerCase()
    .includes(keyword);
}

function parseTime(value: string | undefined): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function compareRecentFirst(
  left: { taskId: number },
  right: { taskId: number },
  leftTime: number,
  rightTime: number,
): number {
  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return right.taskId - left.taskId;
}

function sortTasksByCreatedAtDesc(tasks: DashboardTaskSummary[]): DashboardTaskSummary[] {
  return [...tasks].sort((left, right) =>
    compareRecentFirst(left, right, parseTime(left.createdAt), parseTime(right.createdAt)),
  );
}

export function sortHumanRatingGapsByReviewedAtDesc(
  gaps: HumanRatingGapDashboardItem[],
): HumanRatingGapDashboardItem[] {
  return [...gaps].sort((left, right) =>
    compareRecentFirst(left, right, parseTime(left.reviewedAt), parseTime(right.reviewedAt)),
  );
}

export function sortRiskReviewCalibrationsByTaskTimeDesc(
  items: RiskReviewCalibrationDashboardItem[],
  taskCreatedAtById: Map<number, string>,
): RiskReviewCalibrationDashboardItem[] {
  return [...items].sort((left, right) =>
    compareRecentFirst(
      left,
      right,
      parseTime(taskCreatedAtById.get(left.taskId)),
      parseTime(taskCreatedAtById.get(right.taskId)),
    ),
  );
}

function readHumanReviewAgreement(review: Record<string, unknown> | undefined): boolean | null {
  const agreed = review?.agreeWithResultLevel ?? review?.agree;
  return typeof agreed === "boolean" ? agreed : null;
}

export function filterRiskReviewCalibrations(
  items: RiskReviewCalibrationDashboardItem[],
  query: {
    keyword?: string;
    agreement?: "agreed" | "disagreed";
    manualAnalysisStatus?: ManualAnalysisStatus;
  },
) {
  const keyword = query.keyword?.trim().toLowerCase();
  return items
    .filter((item) =>
      matchesDashboardAnalysisKeyword(
        {
          ...item,
          riskTitle: typeof item.resultRisk?.title === "string" ? item.resultRisk.title : undefined,
        },
        keyword,
      ),
    )
    .filter((item) => {
      if (!query.agreement) {
        return true;
      }
      const agreed = readHumanReviewAgreement(item.humanReview);
      return query.agreement === "agreed" ? agreed === true : agreed === false;
    })
    .filter((item) => {
      if (!query.manualAnalysisStatus) {
        return true;
      }
      return item.manualAnalysisStatus === query.manualAnalysisStatus;
    });
}

export function buildNegativeResults(
  tasks: DashboardTaskSummary[],
  ruleRuns: RuleViolationRunSnapshot[],
  scoreThreshold: number,
) {
  const taskIds = new Set(tasks.map((task) => task.taskId));
  const failedTasks = sortTasksByCreatedAtDesc(
    tasks.filter((task) => task.statusCategory === "failed"),
  );
  const lowScoreTasks = sortTasksByCreatedAtDesc(
    tasks.filter((task) => typeof task.score === "number" && task.score < scoreThreshold),
  );
  const hardGateTasks = sortTasksByCreatedAtDesc(
    tasks.filter((task) => task.hardGateTriggered === true),
  );
  const highRiskTasks = tasks.filter((task) => task.risks.some((risk) => risk.level === "high"));
  const riskCounts = new Map<string, number>();
  for (const task of tasks) {
    for (const risk of task.risks) {
      if (risk.level) {
        riskCounts.set(risk.level, (riskCounts.get(risk.level) ?? 0) + 1);
      }
    }
  }

  const ruleStats = new Map<
    string,
    {
      pack_id: string;
      rule_id: string;
      rule_summary: string;
      violationCount: number;
      affectedTaskIds: Set<number>;
      lastViolatedAt: string;
    }
  >();
  for (const run of ruleRuns) {
    if (!taskIds.has(run.taskId)) {
      continue;
    }
    for (const rule of run.rules) {
      if (rule.result !== "不满足") {
        continue;
      }
      const key = `${rule.pack_id}:${rule.rule_id}`;
      const existing = ruleStats.get(key) ?? {
        pack_id: rule.pack_id,
        rule_id: rule.rule_id,
        rule_summary: rule.rule_summary,
        violationCount: 0,
        affectedTaskIds: new Set<number>(),
        lastViolatedAt: run.completedAt,
      };
      existing.violationCount += 1;
      existing.affectedTaskIds.add(run.taskId);
      if (Date.parse(run.completedAt) > Date.parse(existing.lastViolatedAt)) {
        existing.lastViolatedAt = run.completedAt;
      }
      ruleStats.set(key, existing);
    }
  }

  const topRuleViolations = Array.from(ruleStats.values())
    .map((rule) => ({
      pack_id: rule.pack_id,
      rule_id: rule.rule_id,
      rule_summary: rule.rule_summary,
      violationCount: rule.violationCount,
      affectedTaskIds: Array.from(rule.affectedTaskIds).sort((left, right) => left - right),
      lastViolatedAt: rule.lastViolatedAt,
    }))
    .sort(
      (left, right) =>
        right.violationCount - left.violationCount ||
        Date.parse(right.lastViolatedAt) - Date.parse(left.lastViolatedAt) ||
        left.rule_id.localeCompare(right.rule_id),
    );

  return {
    summary: {
      totalCaseCount: tasks.length,
      failedTaskCount: failedTasks.length,
      lowScoreTaskCount: lowScoreTasks.length,
      hardGateTaskCount: hardGateTasks.length,
      highRiskTaskCount: highRiskTasks.length,
      violatedRuleCount: topRuleViolations.length,
    },
    failedTasks,
    lowScoreTasks,
    hardGateTasks,
    riskLevelCounts: Array.from(riskCounts.entries()).map(([level, count]) => ({ level, count })),
    topRuleViolations,
  };
}

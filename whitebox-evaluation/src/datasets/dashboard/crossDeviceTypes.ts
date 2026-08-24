import type {
  DashboardStatusCategory,
  RiskReviewCalibrationDashboardItem,
} from "./dashboardTypes.js";

export type CrossDeviceOfficialLinterResult = {
  ruleId: string;
  ruleResultId?: string;
  sourceRuleSet?: string;
  severity?: string;
  findingCount: number;
  conclusion?: string;
};

export type CrossDeviceRuleAuditResult = {
  packId?: string;
  packDisplayName?: string;
  ruleId: string;
  ruleSummary?: string;
  ruleSource?: string;
  result?: string;
  conclusion?: string;
};

export type CrossDeviceBoundRulePack = {
  packId: string;
  displayName: string;
};

export type CrossDeviceRuleAuditCounts = {
  violated: number;
  review: number;
  satisfied: number;
  notInvolved: number;
  total: number;
};

export type CrossDeviceRiskSummary = {
  level?: string;
  title?: string;
};

export type CrossDeviceRelatedTask = {
  taskId: number;
  testCaseId?: number;
  name: string;
  status: string;
  statusCategory: DashboardStatusCategory;
  taskType: string;
  score: number | null;
  hardGateTriggered: boolean | null;
  createdAt: string;
  updatedAt: string;
  resultAvailable: boolean;
  reasons: string[];
  officialLinterRunStatus?: string;
  crossDeviceRuleSetApplied: boolean;
  crossDeviceFindingCount: number;
  riskCount: number;
  boundRulePacks: CrossDeviceBoundRulePack[];
  crossDeviceRuleAuditCounts: CrossDeviceRuleAuditCounts;
  crossDeviceRuleAuditResults: CrossDeviceRuleAuditResult[];
  crossDeviceOfficialLinterResults: CrossDeviceOfficialLinterResult[];
  topRuleViolations: Array<{
    ruleId: string;
    sourceRuleSet: string;
    findingCount: number;
  }>;
  riskLevelCounts: Array<{ level: string; count: number }>;
  risks: CrossDeviceRiskSummary[];
  officialLinterResults: CrossDeviceOfficialLinterResult[];
  ruleAuditResults: CrossDeviceRuleAuditResult[];
};

export type CrossDeviceCaseQuery = {
  keyword?: string;
  from?: string;
  to?: string;
  taskType?: string;
  scoreMin?: number;
  scoreMax?: number;
  sortBy: "updatedAt" | "score" | "taskId";
  sortOrder: "asc" | "desc";
};

export type CrossDeviceRuleViolationQuery = {
  keyword?: string;
  includeOtherRules: boolean;
};

export type CrossDeviceRiskReviewQuery = {
  keyword?: string;
  agreement?: "agreed" | "disagreed";
  riskLevel?: "high" | "medium" | "low";
};

export type CrossDeviceRiskReviewItem = RiskReviewCalibrationDashboardItem;

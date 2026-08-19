import type { StaticRuleAuditResult } from "../../types.js";

// EvaluatedRule 在静态结果上补充命中文件/位置，便于后续构建 evidence 与 violation。
export interface EvaluatedRule extends StaticRuleAuditResult {
  matchedFiles: string[];
  matchedLocations?: string[];
  matchedSnippets?: string[];
  preliminaryData?: Record<string, unknown>;
}

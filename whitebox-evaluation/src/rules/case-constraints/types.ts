import type { CaseRuleDefinition } from "../../types.js";

export type SupportedRuleSource = CaseRuleDefinition["rule_source"];

export interface RawCaseConstraintFile {
  constraints: RawConstraint[];
}

export interface RawConstraint {
  id: string;
  name: string;
  description?: string;
  priority: "P0" | "P1";
  kit?: string[];
  rules: RawConstraintRule[];
}

export interface RawConstraintRule {
  target: string;
  ast?: unknown;
  llm?: string;
}

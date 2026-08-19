import type { CaseConstraintPriority } from "../../types.js";
import type { RawCaseConstraintFile, RawConstraint, RawConstraintRule } from "./types.js";

const TOP_LEVEL_KEYS = ["constraints"];
const CONSTRAINT_KEYS = ["id", "name", "description", "priority", "kit", "rules"];
const RULE_KEYS = ["target", "ast", "llm"];

// expected constraints 支持数组直写或 { constraints } 包装两种格式。
export function parseConstraintFile(value: unknown): RawCaseConstraintFile {
  if (Array.isArray(value)) {
    return {
      constraints: value.map((constraint, index) => parseConstraint(constraint, `[${index}]`)),
    };
  }

  const root = expectRecord(value, "root");
  assertSupportedKeys(root, TOP_LEVEL_KEYS, "root");

  if (!Array.isArray(root.constraints)) {
    throw new Error("constraints must be an array");
  }

  return {
    constraints: root.constraints.map((constraint, index) =>
      parseConstraint(constraint, `constraints[${index}]`),
    ),
  };
}

function parseConstraint(value: unknown, location: string): RawConstraint {
  const constraint = expectRecord(value, location);
  assertSupportedKeys(constraint, CONSTRAINT_KEYS, location);

  const priority = parsePriority(constraint.priority, `${location}.priority`);
  const rules = parseRules(constraint.rules, `${location}.rules`);

  return {
    id: expectString(constraint.id, `${location}.id`),
    name: expectString(constraint.name, `${location}.name`),
    description:
      constraint.description === undefined
        ? undefined
        : expectString(constraint.description, `${location}.description`),
    kit: constraint.kit === undefined ? undefined : parseOptionalStringArray(constraint.kit),
    priority,
    rules,
  };
}

function parseRules(value: unknown, location: string): RawConstraintRule[] {
  if (!Array.isArray(value)) {
    throw new Error(`${location} must be an array`);
  }

  return value.map((rule, index) => parseRule(rule, `${location}[${index}]`));
}

function parseRule(value: unknown, location: string): RawConstraintRule {
  const rule = expectRecord(value, location);
  assertSupportedKeys(rule, RULE_KEYS, location);

  let ast: unknown;
  if (rule.ast !== undefined) {
    if (!Array.isArray(rule.ast)) {
      throw new Error(`${location}.ast must be an array`);
    }
    ast = rule.ast;
  }

  let llm: string | undefined;
  if (rule.llm !== undefined) {
    llm = expectString(rule.llm, `${location}.llm`);
  }

  return {
    target: expectString(rule.target, `${location}.target`),
    ast,
    llm,
  };
}

function parsePriority(value: unknown, location: string): CaseConstraintPriority {
  const priority = expectString(value, location);
  if (priority !== "P0" && priority !== "P1") {
    throw new Error(`${location} must be P0 or P1`);
  }
  return priority;
}

function assertSupportedKeys(
  record: Record<string, unknown>,
  supportedKeys: string[],
  location: string,
): void {
  for (const key of Object.keys(record)) {
    if (!supportedKeys.includes(key)) {
      throw new Error(`Unsupported field at ${location}: ${key}`);
    }
  }
}

function expectRecord(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, location: string): string {
  if (typeof value !== "string") {
    throw new Error(`${location} must be a string`);
  }
  return value;
}

function parseOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length > 0 ? strings : undefined;
}

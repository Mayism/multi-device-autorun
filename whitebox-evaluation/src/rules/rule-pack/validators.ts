import type { RuleImpact, RuleMetricGroup, StaticDetectorMode } from "../types/ruleTypes.js";
import { ALLOWED_IMPACTS, ALLOWED_METRIC_GROUPS, ALLOWED_STATIC_MODES } from "./schema.js";

// YAML 解析器使用严格字段校验，避免规则包拼写错误被静默忽略。
export function assertSupportedKeys(
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

export function expectRecord(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function expectString(value: unknown, location: string): string {
  if (typeof value !== "string") {
    throw new Error(`${location} must be a string`);
  }
  return value;
}

export function expectStringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${location} must be an array`);
  }
  const entries = value.filter((item): item is string => typeof item === "string");
  if (entries.length !== value.length) {
    throw new Error(`${location} must only contain strings`);
  }
  return entries;
}

export function expectBoolean(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${location} must be a boolean`);
  }
  return value;
}

export function expectStaticMode(value: unknown, location: string): StaticDetectorMode {
  const mode = expectString(value, location);
  if (!ALLOWED_STATIC_MODES.includes(mode as StaticDetectorMode)) {
    throw new Error(`${location} must be one of ${ALLOWED_STATIC_MODES.join(", ")}`);
  }
  return mode as StaticDetectorMode;
}

export function expectMetricGroups(value: unknown, location: string): RuleMetricGroup[] {
  const groups = expectStringArray(value, location);
  for (const group of groups) {
    if (!ALLOWED_METRIC_GROUPS.includes(group as RuleMetricGroup)) {
      throw new Error(`${location} must only contain ${ALLOWED_METRIC_GROUPS.join(", ")}`);
    }
  }
  return groups as RuleMetricGroup[];
}

export function expectImpact(value: unknown, location: string): RuleImpact {
  const impact = expectString(value, location);
  if (!ALLOWED_IMPACTS.includes(impact as RuleImpact)) {
    throw new Error(`${location} must be one of ${ALLOWED_IMPACTS.join(", ")}`);
  }
  return impact as RuleImpact;
}

export function expectPriority(value: unknown, location: string): "P0" | "P1" {
  const priority = expectString(value, location);
  if (priority !== "P0" && priority !== "P1") {
    throw new Error(`${location} must be P0 or P1`);
  }
  return priority;
}

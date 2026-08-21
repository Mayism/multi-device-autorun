import fs from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import type { TaskType, RiskItem } from "../types.js";

export type RiskTaxonomyLevel = "low" | "medium" | "high";

export interface RiskTaxonomyPrimaryItem {
  dimension: string;
  item: string;
}

export type RiskTaxonomyPrimaryItemsByTask = Partial<
  Record<TaskType | "all", RiskTaxonomyPrimaryItem>
>;

export interface RiskTaxonomyEntry {
  code: string;
  level: RiskTaxonomyLevel;
  title: string;
  description: string;
  matchHints: string[];
  primaryItem?: RiskTaxonomyPrimaryItem;
  primaryItemsByTask?: RiskTaxonomyPrimaryItemsByTask;
}

export interface RiskTaxonomy {
  version: string;
  entries: RiskTaxonomyEntry[];
  scoreEntries: RiskTaxonomyEntry[];
  reviewOnlyEntries: RiskTaxonomyEntry[];
}

const ALLOWED_LEVELS: RiskTaxonomyLevel[] = ["low", "medium", "high"];
const TASK_KEYS: Array<TaskType | "all"> = ["all", "full_generation", "continuation", "bug_fix"];
const ROOT_KEYS = ["version", "entries", "score_taxonomy", "review_only_taxonomy"];
export const OTHER_ISSUE_RISK_CODE = "OTHER_ISSUE";
const ENTRY_KEYS = [
  "code",
  "level",
  "title",
  "description",
  "matchHints",
  "match_hints",
  "primaryItem",
  "primary_item",
  "primaryItemsByTask",
  "primary_items_by_task",
];
const PRIMARY_ITEM_KEYS = ["dimension", "item"];

export function loadRiskTaxonomy(filePath: string): RiskTaxonomy {
  if (!fs.existsSync(filePath)) {
    throw new Error(`risk taxonomy file not found: ${path.resolve(filePath)}`);
  }

  const parsed = load(fs.readFileSync(filePath, "utf-8"));
  const root = expectRecord(parsed, filePath);
  assertSupportedKeys(root, ROOT_KEYS, filePath);

  const hasSplitTaxonomy =
    root.score_taxonomy !== undefined || root.review_only_taxonomy !== undefined;
  const version = typeof root.version === "string" ? root.version : "v1";

  if (hasSplitTaxonomy) {
    const scoreEntries = parseEntryArray(root.score_taxonomy, `${filePath}.score_taxonomy`, true);
    const reviewOnlyEntries = parseEntryArray(
      root.review_only_taxonomy,
      `${filePath}.review_only_taxonomy`,
      false,
    );
    return {
      version,
      entries: scoreEntries,
      scoreEntries,
      reviewOnlyEntries,
    };
  }

  const legacyEntries = parseEntryArray(root.entries, `${filePath}.entries`, false);
  const reviewOnlyEntries = legacyEntries.filter(
    (entry) => entry.code === "EVALUATION_METADATA_RISK",
  );
  const scoreEntries = legacyEntries.filter((entry) => entry.code !== "EVALUATION_METADATA_RISK");
  return {
    version,
    entries: scoreEntries,
    scoreEntries,
    reviewOnlyEntries,
  };
}

export function findRiskTaxonomyEntry(
  taxonomy: RiskTaxonomy,
  code: string | undefined,
): RiskTaxonomyEntry | undefined {
  if (!code) {
    return undefined;
  }
  return taxonomy.entries.find((entry) => entry.code === code);
}

export function resolveRiskTaxonomyPrimaryItem(
  entry: RiskTaxonomyEntry,
  taskType: TaskType,
): RiskTaxonomyPrimaryItem | undefined {
  return entry.primaryItemsByTask?.[taskType] ?? entry.primaryItemsByTask?.all ?? entry.primaryItem;
}

export function normalizeRiskItem(risk: RiskItem, taxonomy: RiskTaxonomy): RiskItem {
  const entry =
    findRiskTaxonomyEntry(taxonomy, risk.risk_code) ??
    (risk.risk_code ? findRiskTaxonomyEntry(taxonomy, OTHER_ISSUE_RISK_CODE) : undefined);
  if (!entry) {
    return risk;
  }

  return {
    ...risk,
    risk_code: entry.code,
    risk_category: entry.level,
    level: entry.level,
    title: entry.title,
    description: risk.description || entry.description,
  };
}

function parseEntryArray(
  value: unknown,
  location: string,
  requirePrimaryItem: boolean,
): RiskTaxonomyEntry[] {
  const entries = value === undefined ? [] : value;
  if (!Array.isArray(entries)) {
    throw new Error(`${location} must be an array`);
  }
  return entries.flatMap((entry, index) =>
    parseRiskTaxonomyEntry(entry, `${location}[${index}]`, requirePrimaryItem),
  );
}

function parseRiskTaxonomyEntry(
  value: unknown,
  location: string,
  requirePrimaryItem: boolean,
): RiskTaxonomyEntry[] {
  const record = expectRecord(value, location);
  assertSupportedKeys(record, ENTRY_KEYS, location);

  const code = expectString(record.code, `${location}.code`);
  const level = expectLevel(record.level, `${location}.level`);
  const title = expectString(record.title, `${location}.title`);
  const description = expectString(record.description, `${location}.description`);
  const matchHintsSource = record.matchHints ?? record.match_hints;
  const primaryItemSource = record.primaryItem ?? record.primary_item;
  const primaryItemsByTaskSource = record.primaryItemsByTask ?? record.primary_items_by_task;
  const primaryItem =
    primaryItemSource === undefined
      ? undefined
      : parsePrimaryItem(primaryItemSource, `${location}.primaryItem`);
  const primaryItemsByTask =
    primaryItemsByTaskSource === undefined
      ? undefined
      : parsePrimaryItemsByTask(primaryItemsByTaskSource, `${location}.primaryItemsByTask`);

  if (requirePrimaryItem && !primaryItem && !primaryItemsByTask) {
    throw new Error(`${location}.primaryItem is required for score taxonomy entries`);
  }

  return [
    {
      code,
      level,
      title,
      description,
      matchHints:
        matchHintsSource === undefined
          ? []
          : expectStringArray(matchHintsSource, `${location}.matchHints`),
      primaryItem: primaryItem ?? primaryItemsByTask?.all ?? firstPrimaryItem(primaryItemsByTask),
      primaryItemsByTask,
    },
  ];
}

function parsePrimaryItemsByTask(value: unknown, location: string): RiskTaxonomyPrimaryItemsByTask {
  const record = expectRecord(value, location);
  assertSupportedKeys(record, TASK_KEYS, location);
  const result: RiskTaxonomyPrimaryItemsByTask = {};
  for (const key of TASK_KEYS) {
    if (record[key] !== undefined) {
      result[key] = parsePrimaryItem(record[key], `${location}.${key}`);
    }
  }
  return result;
}

function parsePrimaryItem(value: unknown, location: string): RiskTaxonomyPrimaryItem {
  const record = expectRecord(value, location);
  assertSupportedKeys(record, PRIMARY_ITEM_KEYS, location);
  return {
    dimension: expectString(record.dimension, `${location}.dimension`),
    item: expectString(record.item, `${location}.item`),
  };
}

function firstPrimaryItem(
  primaryItemsByTask: RiskTaxonomyPrimaryItemsByTask | undefined,
): RiskTaxonomyPrimaryItem | undefined {
  if (!primaryItemsByTask) {
    return undefined;
  }
  for (const key of TASK_KEYS) {
    const item = primaryItemsByTask[key];
    if (item) {
      return item;
    }
  }
  return undefined;
}

function expectLevel(value: unknown, location: string): RiskTaxonomyLevel {
  const level = expectString(value, location);
  if (!ALLOWED_LEVELS.includes(level as RiskTaxonomyLevel)) {
    throw new Error(`${location} must be one of ${ALLOWED_LEVELS.join(", ")}`);
  }
  return level as RiskTaxonomyLevel;
}

function expectStringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${location} must be an array`);
  }
  const strings = value.filter((item): item is string => typeof item === "string");
  if (strings.length !== value.length) {
    throw new Error(`${location} must only contain strings`);
  }
  return strings;
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

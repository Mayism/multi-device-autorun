import fs from "node:fs/promises";
import path from "node:path";
import {
  hwStylisticRuleIds,
  performanceRuleIds,
} from "../../../scoring/officialLinterRuleProfiles.js";
import { resolveOfficialCodeLinterRecommendedRuleSets } from "./recommendedRuleSets.js";

export interface OfficialCodeLinterConfig {
  files: string[];
  ignore: string[];
  ruleSet: string[];
  rules: Record<string, "suggestion" | "warn" | "error">;
}

const suggestionRuleIds = [...performanceRuleIds, ...hwStylisticRuleIds];

function buildSuggestionRules(): OfficialCodeLinterConfig["rules"] {
  return Object.fromEntries(suggestionRuleIds.map((ruleId) => [ruleId, "suggestion"]));
}

export function buildOfficialCodeLinterConfig(input?: {
  ruleSets?: string[];
}): OfficialCodeLinterConfig {
  return {
    files: ["**/*.ets", "**/*.ts", "**/*.js", "**/*.json", "**/*.json5"],
    ignore: [
      "node_modules/**/*",
      "oh_modules/**/*",
      "build/**/*",
      ".preview/**/*",
      "src/ohosTest/**/*",
      "src/test/**/*",
      "hvigorfile.ts",
      "hvigorfile.js",
      "BuildProfile.ets",
    ],
    ruleSet: input?.ruleSets ?? resolveOfficialCodeLinterRecommendedRuleSets({}),
    rules: buildSuggestionRules(),
  };
}

export function serializeOfficialCodeLinterConfig(
  config: OfficialCodeLinterConfig = buildOfficialCodeLinterConfig(),
): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export async function writeOfficialCodeLinterConfig(
  filePath: string,
  input?: { ruleSets?: string[] },
): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    serializeOfficialCodeLinterConfig(buildOfficialCodeLinterConfig(input)),
    "utf-8",
  );
  return filePath;
}

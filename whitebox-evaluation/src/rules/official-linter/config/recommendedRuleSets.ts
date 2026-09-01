import type { CrossDeviceAdaptationUnderstanding } from "../../../types.js";

export const officialCodeLinterBaseRecommendedRuleSets = [
  "plugin:@typescript-eslint/recommended",
  "plugin:@security/recommended",
  "plugin:@performance/recommended",
  "plugin:@hw-stylistic/recommended",
] as const;

export const officialCodeLinterRecommendedRuleSets = officialCodeLinterBaseRecommendedRuleSets;

export const officialCodeLinterCrossDeviceRecommendedRuleSet =
  "plugin:@cross-device-app-dev/recommended" as const;

export function resolveOfficialCodeLinterRecommendedRuleSets(input: {
  crossDeviceAdaptation?: CrossDeviceAdaptationUnderstanding;
}): string[] {
  const ruleSets: string[] = [...officialCodeLinterBaseRecommendedRuleSets];
  if (input.crossDeviceAdaptation?.applicability === "involved") {
    ruleSets.push(officialCodeLinterCrossDeviceRecommendedRuleSet);
  }
  return ruleSets;
}

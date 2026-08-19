import path from "node:path";
import type { CaseRuleDefinition, CrossDeviceAdaptationUnderstanding } from "../../types.js";
import type { RegisteredRule, RegisteredRulePack } from "../types/ruleTypes.js";
import { loadRegisteredRulePacksFromYamlDirectory } from "../rule-pack/yamlLoader.js";
import { crossDeviceAdaptationRulePackId, defaultEnabledRulePackIds } from "./constants.js";
import { normalizeRuntimeRule } from "./runtimeRuleNormalizer.js";

const registeredRulePacks: RegisteredRulePack[] = loadRegisteredRulePacksFromYamlDirectory(
  path.resolve(process.cwd(), "references/rules"),
);

export { crossDeviceAdaptationRulePackId, defaultEnabledRulePackIds };

export function resolveEnabledRulePackIds(input: {
  crossDeviceAdaptation?: CrossDeviceAdaptationUnderstanding;
}): string[] {
  const packIds: string[] = [...defaultEnabledRulePackIds];
  if (input.crossDeviceAdaptation?.applicability === "involved") {
    packIds.push(crossDeviceAdaptationRulePackId);
  }
  return packIds;
}

export function getRegisteredRulePacks(): RegisteredRulePack[] {
  return registeredRulePacks;
}

export function getEnabledRulePacks(enabledPackIds: string[]): RegisteredRulePack[] {
  const enabledSet = new Set(enabledPackIds);
  return registeredRulePacks.filter((pack) => enabledSet.has(pack.packId));
}

export function listRegisteredRules(
  input:
    | Array<RegisteredRule | CaseRuleDefinition>
    | { enabledPackIds?: string[]; runtimeRules?: CaseRuleDefinition[] } = [],
): RegisteredRule[] {
  if (Array.isArray(input)) {
    return [
      ...registeredRulePacks.flatMap((pack) => pack.rules),
      ...input.map(normalizeRuntimeRule),
    ];
  }

  const packs = input.enabledPackIds
    ? getEnabledRulePacks(input.enabledPackIds)
    : registeredRulePacks;
  return [
    ...packs.flatMap((pack) => pack.rules),
    ...(input.runtimeRules ?? []).map(normalizeRuntimeRule),
  ];
}

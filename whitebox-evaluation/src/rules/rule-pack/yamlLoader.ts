import fs from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import type { RegisteredRulePack } from "../types/ruleTypes.js";
import { RULE_PACK_FILE_ORDER } from "./schema.js";
import { parseRulePackDocument } from "./yamlParser.js";

export function loadRegisteredRulePacksFromYamlDirectory(
  directoryPath: string,
): RegisteredRulePack[] {
  if (!fs.existsSync(directoryPath)) {
    return [];
  }

  const files = fs
    .readdirSync(directoryPath)
    .filter((fileName) => fileName.endsWith(".yaml"))
    .sort((left, right) => {
      const leftIndex = RULE_PACK_FILE_ORDER.indexOf(left);
      const rightIndex = RULE_PACK_FILE_ORDER.indexOf(right);
      if (leftIndex !== -1 || rightIndex !== -1) {
        return (
          (leftIndex === -1 ? Number.POSITIVE_INFINITY : leftIndex) -
          (rightIndex === -1 ? Number.POSITIVE_INFINITY : rightIndex)
        );
      }
      return left.localeCompare(right);
    });

  return files.flatMap((fileName) =>
    loadRegisteredRulePackFromYamlFile(path.join(directoryPath, fileName)),
  );
}

function loadRegisteredRulePackFromYamlFile(filePath: string): RegisteredRulePack[] {
  const parsed = load(fs.readFileSync(filePath, "utf-8"));
  return [parseRulePackDocument(parsed, filePath)];
}

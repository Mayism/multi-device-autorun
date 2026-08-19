import fs from "node:fs/promises";
import { load } from "js-yaml";
import type { CaseInput, CaseRuleDefinition } from "../../types.js";
import { mapConstraintToRule } from "./mapper.js";
import { parseConstraintFile } from "./parser.js";

export async function loadCaseConstraintRules(caseInput: CaseInput): Promise<CaseRuleDefinition[]> {
  if (!caseInput.expectedConstraintsPath) {
    return [];
  }

  const rawText = await fs.readFile(caseInput.expectedConstraintsPath, "utf-8");
  const parsed = load(rawText);
  const document = parseConstraintFile(parsed);

  return document.constraints.map((constraint) => mapConstraintToRule(constraint, caseInput));
}

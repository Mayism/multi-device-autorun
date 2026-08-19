import fs from "node:fs/promises";
import path from "node:path";
import type { ArkExpressionFact, ArkFactsIndex } from "./types.js";

export async function writeArkFactsDebugArtifacts(options: {
  caseDir?: string;
  scene?: unknown;
  facts: ArkFactsIndex;
}): Promise<void> {
  if (!options.caseDir) {
    return;
  }
  const outputDir = path.join(options.caseDir, "intermediate", "arkanalyzer");
  await fs.mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeJson(path.join(outputDir, "scene-summary.json"), options.scene ?? {}),
    writeJson(path.join(outputDir, "ark-facts.json"), options.facts),
    writeJson(path.join(outputDir, "diagnostics.json"), options.facts.diagnostics),
    writeJson(path.join(outputDir, "unresolved-expressions.json"), collectUnknownExpressions(options.facts)),
  ]);
}

function collectUnknownExpressions(facts: ArkFactsIndex): Array<{ path: string; expression: ArkExpressionFact }> {
  const unresolved: Array<{ path: string; expression: ArkExpressionFact }> = [];
  for (const component of facts.components) {
    for (const attribute of component.attributes) {
      collectUnknownExpression(
        attribute.expr,
        `component:${component.id}:attribute:${attribute.name}`,
        unresolved,
      );
    }
  }
  for (const declaration of facts.declarations) {
    for (const field of declaration.fields) {
      collectUnknownExpression(field.initializer, `declaration:${declaration.id}:field:${field.name}`, unresolved);
    }
    for (const member of declaration.enumMembers ?? []) {
      collectUnknownExpression(member.initializer, `declaration:${declaration.id}:enum:${member.name}`, unresolved);
    }
  }
  return unresolved;
}

function collectUnknownExpression(
  expression: ArkExpressionFact | undefined,
  expressionPath: string,
  output: Array<{ path: string; expression: ArkExpressionFact }>,
): void {
  if (!expression) {
    return;
  }
  if (expression.kind === "unknown") {
    output.push({ path: expressionPath, expression });
    return;
  }
  if (expression.kind === "array") {
    expression.items.forEach((item, index) =>
      collectUnknownExpression(item, `${expressionPath}[${index}]`, output),
    );
  } else if (expression.kind === "object") {
    for (const [key, value] of Object.entries(expression.properties)) {
      collectUnknownExpression(value, `${expressionPath}.${key}`, output);
    }
  } else if (expression.kind === "call") {
    expression.args.forEach((arg, index) =>
      collectUnknownExpression(arg, `${expressionPath}.arg${index}`, output),
    );
  } else if (expression.kind === "symbol") {
    collectUnknownExpression(expression.resolved, `${expressionPath}.resolved`, output);
  } else if (expression.kind === "breakpointValue") {
    for (const [key, value] of Object.entries(expression.values)) {
      collectUnknownExpression(value, `${expressionPath}.${key}`, output);
    }
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

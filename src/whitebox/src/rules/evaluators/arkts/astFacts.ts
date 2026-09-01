import type { ArkDeclarationFact, ArkExpressionFact, ArkFactsIndex } from "../../arkfacts/index.js";
import type {
  ArktsFileFacts,
  ArktsLightScanIndex,
  ArktsNamedDeclarationFact,
} from "./lightScanner.js";

export function buildArktsLightScanIndexFromArkFacts(
  facts: ArkFactsIndex,
  options: { includedFilePaths?: Set<string> } = {},
): ArktsLightScanIndex {
  const includedFilePaths = options.includedFilePaths;
  const fileMap = new Map<string, ArktsFileFacts>();
  for (const file of facts.files) {
    if (includedFilePaths && !includedFilePaths.has(file.relativePath)) {
      continue;
    }
    fileMap.set(file.relativePath, emptyFileFacts(file.relativePath));
  }
  for (const declaration of facts.declarations) {
    if (includedFilePaths && !includedFilePaths.has(declaration.filePath)) {
      continue;
    }
    const file = ensureFile(fileMap, declaration.filePath);
    appendDeclaration(file, declaration);
  }
  for (const method of facts.methods) {
    if (includedFilePaths && !includedFilePaths.has(method.filePath)) {
      continue;
    }
    const file = ensureFile(fileMap, method.filePath);
    file.namedDeclarations.push({
      relativePath: method.filePath,
      line: method.line ?? 1,
      kind: "method",
      name: method.name,
      text: `method ${method.name}`,
    });
    for (const parameter of method.parameters) {
      file.namedDeclarations.push({
        relativePath: method.filePath,
        line: method.line ?? 1,
        kind: "parameter",
        name: parameter.name,
        typeName: parameter.typeText,
        text: `${parameter.name}${parameter.typeText ? `: ${parameter.typeText}` : ""}`,
      });
    }
    for (const assignment of method.assignments) {
      file.assignments.push({
        relativePath: method.filePath,
        line: assignment.line ?? method.line ?? 1,
        name: assignment.target,
        text: `${assignment.target} = ${renderExpression(assignment.value)}`,
      });
    }
  }

  const files = [...fileMap.values()];
  const classNames = new Set(files.flatMap((file) => file.classes.map((item) => item.name)));
  const interfaceNames = new Set(files.flatMap((file) => file.interfaces.map((item) => item.name)));
  const namespaceNames = new Set(files.flatMap((file) => file.namespaces.map((item) => item.name)));
  const typeLikeNames = new Set([
    ...classNames,
    ...interfaceNames,
    ...namespaceNames,
    ...files.flatMap((file) => file.enums.map((item) => item.name)),
    ...files.flatMap((file) => file.typeAliases.map((item) => item.name)),
  ]);
  const valueNames = new Set(
    files.flatMap((file) =>
      file.namedDeclarations
        .filter((item) => ["function", "method", "variable"].includes(item.kind))
        .map((item) => item.name),
    ),
  );

  return {
    files,
    classNames,
    interfaceNames,
    typeLikeNames,
    namespaceNames,
    valueNames,
  };
}

function appendDeclaration(file: ArktsFileFacts, declaration: ArkDeclarationFact): void {
  const line = declaration.line ?? 1;
  if (declaration.kind === "class" || declaration.kind === "struct") {
    file.classes.push({ name: declaration.name, line });
    file.heritage.push({
      relativePath: declaration.filePath,
      line,
      kind: "class",
      name: declaration.name,
      extendsNames: declaration.extendsNames,
      implementsNames: declaration.implementsNames,
      text: `class ${declaration.name}`,
    });
  } else if (declaration.kind === "interface") {
    file.interfaces.push({ name: declaration.name, line });
    file.heritage.push({
      relativePath: declaration.filePath,
      line,
      kind: "interface",
      name: declaration.name,
      extendsNames: declaration.extendsNames,
      implementsNames: [],
      text: `interface ${declaration.name}`,
    });
  } else if (declaration.kind === "enum") {
    file.enums.push({
      relativePath: declaration.filePath,
      line,
      name: declaration.name,
      memberInitializers: (declaration.enumMembers ?? []).map((member) => ({
        name: member.name,
        initializer: renderExpression(member.initializer),
      })),
      text: `enum ${declaration.name}`,
    });
    for (const member of declaration.enumMembers ?? []) {
      file.namedDeclarations.push({
        relativePath: declaration.filePath,
        line: member.line ?? line,
        kind: "enumMember",
        name: member.name,
        initializer: renderExpression(member.initializer),
        text: member.name,
      });
    }
  } else if (declaration.kind === "namespace") {
    file.namespaces.push({ name: declaration.name, line });
  }

  file.namedDeclarations.push({
    relativePath: declaration.filePath,
    line,
    kind: declaration.kind === "struct" ? "class" : declaration.kind,
    name: declaration.name,
    text: `${declaration.kind} ${declaration.name}`,
  } as ArktsNamedDeclarationFact);

  for (const field of declaration.fields) {
    file.classProperties.push({
      relativePath: declaration.filePath,
      line: field.line ?? line,
      name: field.name,
      text: field.name,
      hasAccessModifier: Boolean(field.accessModifier),
    });
    file.namedDeclarations.push({
      relativePath: declaration.filePath,
      line: field.line ?? line,
      kind: "classProperty",
      name: field.name,
      typeName: field.typeText,
      initializer: renderExpression(field.initializer),
      text: field.name,
    });
  }
}

function renderExpression(expression: ArkExpressionFact | undefined): string | undefined {
  if (!expression) {
    return undefined;
  }
  if (expression.kind === "literal") {
    return typeof expression.value === "string" ? JSON.stringify(expression.value) : `${expression.value}`;
  }
  if (expression.kind === "enum" || expression.kind === "resource" || expression.kind === "symbol") {
    return expression.name;
  }
  if (expression.kind === "array") {
    return `[${expression.items.map(renderExpression).join(", ")}]`;
  }
  if (expression.kind === "object") {
    return `{ ${Object.entries(expression.properties)
      .map(([key, value]) => `${key}: ${renderExpression(value)}`)
      .join(", ")} }`;
  }
  if (expression.kind === "call") {
    return `${expression.callee}(${expression.args.map(renderExpression).join(", ")})`;
  }
  if (expression.kind === "breakpointValue") {
    return `{ ${Object.entries(expression.values)
      .map(([key, value]) => `${key}: ${renderExpression(value)}`)
      .join(", ")} }`;
  }
  return expression.raw;
}

function ensureFile(fileMap: Map<string, ArktsFileFacts>, relativePath: string): ArktsFileFacts {
  const existing = fileMap.get(relativePath);
  if (existing) {
    return existing;
  }
  const created = emptyFileFacts(relativePath);
  fileMap.set(relativePath, created);
  return created;
}

function emptyFileFacts(relativePath: string): ArktsFileFacts {
  return {
    relativePath,
    classes: [],
    interfaces: [],
    typeAliases: [],
    enums: [],
    namespaces: [],
    namedDeclarations: [],
    heritage: [],
    classProperties: [],
    variableDeclarations: [],
    assignments: [],
    objectLiteralClassInitializations: [],
    spacingIssues: [],
  };
}

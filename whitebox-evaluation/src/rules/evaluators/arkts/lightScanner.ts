import path from "node:path";
import type { CollectedEvidence, WorkspaceFile } from "../../evidence/types.js";

export interface ArktsClassPropertyFact {
  relativePath: string;
  line: number;
  name: string;
  text: string;
  hasAccessModifier: boolean;
}

export interface ArktsVariableDeclarationFact {
  relativePath: string;
  line: number;
  name: string;
  kind: "let" | "const" | "var";
  scope: "topLevel" | "local";
  typeName?: string;
  initializer?: string;
  text: string;
}

export interface ArktsObjectLiteralClassInitFact {
  relativePath: string;
  line: number;
  className: string;
  text: string;
}

export type ArktsDeclarationKind =
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "namespace"
  | "function"
  | "method"
  | "variable"
  | "parameter"
  | "classProperty"
  | "enumMember";

export interface ArktsNamedDeclarationFact {
  relativePath: string;
  line: number;
  kind: ArktsDeclarationKind;
  name: string;
  typeName?: string;
  initializer?: string;
  text: string;
}

export interface ArktsHeritageFact {
  relativePath: string;
  line: number;
  kind: "class" | "interface";
  name: string;
  extendsNames: string[];
  implementsNames: string[];
  text: string;
}

export interface ArktsEnumFact {
  relativePath: string;
  line: number;
  name: string;
  memberInitializers: Array<{ name: string; initializer?: string }>;
  text: string;
}

export interface ArktsAssignmentFact {
  relativePath: string;
  line: number;
  name: string;
  text: string;
}

export interface ArktsFileFacts {
  relativePath: string;
  classes: Array<{ name: string; line: number }>;
  interfaces: Array<{ name: string; line: number }>;
  typeAliases: Array<{ name: string; line: number }>;
  enums: ArktsEnumFact[];
  namespaces: Array<{ name: string; line: number }>;
  namedDeclarations: ArktsNamedDeclarationFact[];
  heritage: ArktsHeritageFact[];
  classProperties: ArktsClassPropertyFact[];
  variableDeclarations: ArktsVariableDeclarationFact[];
  assignments: ArktsAssignmentFact[];
  objectLiteralClassInitializations: ArktsObjectLiteralClassInitFact[];
  spacingIssues: Array<{ relativePath: string; line: number; text: string }>;
}

export interface ArktsLightScanIndex {
  files: ArktsFileFacts[];
  classNames: Set<string>;
  interfaceNames: Set<string>;
  typeLikeNames: Set<string>;
  namespaceNames: Set<string>;
  valueNames: Set<string>;
}

function stripLineComment(line: string): string {
  return line.replace(/\/\/.*$/, "");
}

function isPatchLine(file: WorkspaceFile, line: number): boolean {
  return file.patchLineNumbers === undefined || file.patchLineNumbers.includes(line);
}

function splitTypeList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .map((item) => item.match(/[A-Za-z_$][\w$]*/)?.[0])
    .filter((item): item is string => Boolean(item));
}

function parseParameters(parameters: string): Array<{ name: string; typeName?: string }> {
  return parameters
    .split(",")
    .map((item) => item.trim())
    .flatMap((item) => {
      const match =
        /^(?:public|private|protected|readonly\s+)*([A-Za-z_$][\w$]*)\??\s*(?::\s*([A-Za-z_$][\w$]*))?/.exec(
          item,
        );
      if (!match?.[1]) {
        return [];
      }
      return [
        {
          name: match[1],
          ...(match[2] ? { typeName: match[2] } : {}),
        },
      ];
    });
}

function parseEnumMembers(body: string): Array<{ name: string; initializer?: string }> {
  return body
    .split(",")
    .map((item) => item.trim())
    .flatMap((item) => {
      const match = /^([A-Za-z_$][\w$]*)(?:\s*=\s*(.+))?$/.exec(item);
      if (!match?.[1]) {
        return [];
      }
      return [
        {
          name: match[1],
          ...(match[2] ? { initializer: match[2].trim() } : {}),
        },
      ];
    });
}

function hasSpacingIssue(rawLine: string): boolean {
  const line = stripLineComment(rawLine);
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  if (/\s+$/.test(line)) {
    return true;
  }
  return /\S {2,}\S/.test(trimmed);
}

function addParameterDeclarations(
  namedDeclarations: ArktsNamedDeclarationFact[],
  file: WorkspaceFile,
  line: number,
  rawLine: string,
  parameters: string,
): void {
  if (!isPatchLine(file, line)) {
    return;
  }
  for (const parameter of parseParameters(parameters)) {
    namedDeclarations.push({
      relativePath: file.relativePath,
      line,
      kind: "parameter",
      name: parameter.name,
      ...(parameter.typeName ? { typeName: parameter.typeName } : {}),
      text: rawLine.trim(),
    });
  }
}

function scanFile(file: WorkspaceFile): ArktsFileFacts {
  const lines = file.content.split(/\r?\n/);
  const classes: ArktsFileFacts["classes"] = [];
  const interfaces: ArktsFileFacts["interfaces"] = [];
  const typeAliases: ArktsFileFacts["typeAliases"] = [];
  const enums: ArktsEnumFact[] = [];
  const namespaces: ArktsFileFacts["namespaces"] = [];
  const namedDeclarations: ArktsNamedDeclarationFact[] = [];
  const heritage: ArktsHeritageFact[] = [];
  const classProperties: ArktsClassPropertyFact[] = [];
  const variableDeclarations: ArktsVariableDeclarationFact[] = [];
  const assignments: ArktsAssignmentFact[] = [];
  const objectLiteralClassInitializations: ArktsObjectLiteralClassInitFact[] = [];
  const spacingIssues: ArktsFileFacts["spacingIssues"] = [];
  const classStack: Array<{ name: string; depth: number }> = [];
  let currentEnum: ArktsEnumFact | undefined;
  let braceDepth = 0;

  lines.forEach((rawLine, index) => {
    const line = index + 1;
    const text = stripLineComment(rawLine).trim();
    if (isPatchLine(file, line) && hasSpacingIssue(rawLine)) {
      spacingIssues.push({ relativePath: file.relativePath, line, text: rawLine.trim() });
    }

    const classMatch =
      /\bclass\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$]*))?(?:\s+implements\s+([^{]+))?/.exec(
        text,
      );
    if (classMatch?.[1]) {
      classes.push({ name: classMatch[1], line });
      if (isPatchLine(file, line)) {
        namedDeclarations.push({
          relativePath: file.relativePath,
          line,
          kind: "class",
          name: classMatch[1],
          text: rawLine.trim(),
        });
        heritage.push({
          relativePath: file.relativePath,
          line,
          kind: "class",
          name: classMatch[1],
          extendsNames: splitTypeList(classMatch[2]),
          implementsNames: splitTypeList(classMatch[3]),
          text: rawLine.trim(),
        });
      }
      classStack.push({ name: classMatch[1], depth: braceDepth + 1 });
    }

    const interfaceMatch = /\binterface\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([^{]+))?/.exec(text);
    if (interfaceMatch?.[1]) {
      interfaces.push({ name: interfaceMatch[1], line });
      if (isPatchLine(file, line)) {
        namedDeclarations.push({
          relativePath: file.relativePath,
          line,
          kind: "interface",
          name: interfaceMatch[1],
          text: rawLine.trim(),
        });
        heritage.push({
          relativePath: file.relativePath,
          line,
          kind: "interface",
          name: interfaceMatch[1],
          extendsNames: splitTypeList(interfaceMatch[2]),
          implementsNames: [],
          text: rawLine.trim(),
        });
      }
    }

    const typeMatch = /\btype\s+([A-Za-z_$][\w$]*)\b/.exec(text);
    if (typeMatch?.[1]) {
      typeAliases.push({ name: typeMatch[1], line });
      if (isPatchLine(file, line)) {
        namedDeclarations.push({
          relativePath: file.relativePath,
          line,
          kind: "type",
          name: typeMatch[1],
          text: rawLine.trim(),
        });
      }
    }

    if (currentEnum && !/\benum\s+([A-Za-z_$][\w$]*)\b/.test(text)) {
      const memberText = text.replace(/\}.*$/, "").replace(/,$/, "").trim();
      const members = parseEnumMembers(memberText);
      currentEnum.memberInitializers.push(...members);
      if (isPatchLine(file, line)) {
        for (const member of members) {
          namedDeclarations.push({
            relativePath: file.relativePath,
            line,
            kind: "enumMember",
            name: member.name,
            ...(member.initializer ? { initializer: member.initializer } : {}),
            text: rawLine.trim(),
          });
        }
      }
      if (text.includes("}")) {
        currentEnum = undefined;
      }
    }

    const enumMatch = /\benum\s+([A-Za-z_$][\w$]*)\b(?:[^{]*\{(.*)\})?/.exec(text);
    if (enumMatch?.[1]) {
      const members = parseEnumMembers(enumMatch[2] ?? "");
      const enumFact: ArktsEnumFact = {
        relativePath: file.relativePath,
        line,
        name: enumMatch[1],
        memberInitializers: members,
        text: rawLine.trim(),
      };
      enums.push(enumFact);
      if (text.includes("{") && !text.includes("}")) {
        currentEnum = enumFact;
      }
      if (isPatchLine(file, line)) {
        namedDeclarations.push({
          relativePath: file.relativePath,
          line,
          kind: "enum",
          name: enumMatch[1],
          text: rawLine.trim(),
        });
        for (const member of members) {
          namedDeclarations.push({
            relativePath: file.relativePath,
            line,
            kind: "enumMember",
            name: member.name,
            ...(member.initializer ? { initializer: member.initializer } : {}),
            text: rawLine.trim(),
          });
        }
      }
    }

    const namespaceMatch = /\bnamespace\s+([A-Za-z_$][\w$]*)\b/.exec(text);
    if (namespaceMatch?.[1]) {
      namespaces.push({ name: namespaceMatch[1], line });
      if (isPatchLine(file, line)) {
        namedDeclarations.push({
          relativePath: file.relativePath,
          line,
          kind: "namespace",
          name: namespaceMatch[1],
          text: rawLine.trim(),
        });
      }
    }

    const functionMatch = /^(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/.exec(text);
    if (functionMatch?.[1] && isPatchLine(file, line)) {
      namedDeclarations.push({
        relativePath: file.relativePath,
        line,
        kind: "function",
        name: functionMatch[1],
        text: rawLine.trim(),
      });
      addParameterDeclarations(namedDeclarations, file, line, rawLine, functionMatch[2] ?? "");
    }

    const currentClass = classStack.at(-1);
    if (currentClass && braceDepth === currentClass.depth && isPatchLine(file, line)) {
      const propertyMatch =
        /^(?:(?:@[\w.]+(?:\([^)]*\))?)\s*)*(?:(public|private|protected)\s+)?(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(?::|=)/.exec(
          text,
        );
      const looksLikeMethod = /^[A-Za-z_$][\w$]*\s*\(/.test(text) || /\)\s*\{?\s*$/.test(text);
      if (propertyMatch?.[2] && !looksLikeMethod && !text.startsWith("constructor")) {
        classProperties.push({
          relativePath: file.relativePath,
          line,
          name: propertyMatch[2],
          text: rawLine.trim(),
          hasAccessModifier: Boolean(propertyMatch[1]),
        });
        const typeMatch = /:\s*([A-Za-z_$][\w$]*)/.exec(text);
        namedDeclarations.push({
          relativePath: file.relativePath,
          line,
          kind: "classProperty",
          name: propertyMatch[2],
          ...(typeMatch?.[1] ? { typeName: typeMatch[1] } : {}),
          text: rawLine.trim(),
        });
      }

      const methodMatch =
        /^(?:(?:public|private|protected)\s+)?(?:static\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/.exec(
          text,
        );
      if (methodMatch?.[1] && !text.startsWith("constructor")) {
        namedDeclarations.push({
          relativePath: file.relativePath,
          line,
          kind: "method",
          name: methodMatch[1],
          text: rawLine.trim(),
        });
        addParameterDeclarations(namedDeclarations, file, line, rawLine, methodMatch[2] ?? "");
      }
    }

    const declarationMatch =
      /^(let|const|var)\s+([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?\s*(?:=\s*(.+?))?\s*;?\s*$/.exec(
        text,
      );
    if (declarationMatch?.[1] && declarationMatch[2] && isPatchLine(file, line)) {
      variableDeclarations.push({
        relativePath: file.relativePath,
        line,
        kind: declarationMatch[1] as "let" | "const" | "var",
        name: declarationMatch[2],
        scope: braceDepth === 0 ? "topLevel" : "local",
        ...(declarationMatch[3] ? { typeName: declarationMatch[3] } : {}),
        ...(declarationMatch[4] ? { initializer: declarationMatch[4] } : {}),
        text: rawLine.trim(),
      });
      namedDeclarations.push({
        relativePath: file.relativePath,
        line,
        kind: "variable",
        name: declarationMatch[2],
        ...(declarationMatch[3] ? { typeName: declarationMatch[3] } : {}),
        ...(declarationMatch[4] ? { initializer: declarationMatch[4] } : {}),
        text: rawLine.trim(),
      });
      if (declarationMatch[3] && declarationMatch[4]?.trim().startsWith("{")) {
        objectLiteralClassInitializations.push({
          relativePath: file.relativePath,
          line,
          className: declarationMatch[3],
          text: rawLine.trim(),
        });
      }
    }

    const castObjectLiteralMatch = /return\s+\{.*\}\s+as\s+([A-Za-z_$][\w$]*)/.exec(text);
    if (castObjectLiteralMatch?.[1] && isPatchLine(file, line)) {
      objectLiteralClassInitializations.push({
        relativePath: file.relativePath,
        line,
        className: castObjectLiteralMatch[1],
        text: rawLine.trim(),
      });
    }

    const assignmentMatch = /^([A-Za-z_$][\w$]*)\s*(?:[+\-*/%]?=|\+\+|--)/.exec(text);
    if (assignmentMatch?.[1] && !/^(let|const|var)\b/.test(text)) {
      assignments.push({
        relativePath: file.relativePath,
        line,
        name: assignmentMatch[1],
        text: rawLine.trim(),
      });
    }

    for (const char of text) {
      if (char === "{") {
        braceDepth += 1;
      } else if (char === "}") {
        braceDepth = Math.max(0, braceDepth - 1);
        while (classStack.length > 0 && braceDepth < (classStack.at(-1)?.depth ?? 0)) {
          classStack.pop();
        }
      }
    }
  });

  return {
    relativePath: file.relativePath,
    classes,
    interfaces,
    typeAliases,
    enums,
    namespaces,
    namedDeclarations,
    heritage,
    classProperties,
    variableDeclarations,
    assignments,
    objectLiteralClassInitializations,
    spacingIssues,
  };
}

export function scanArktsLightFacts(
  evidence: CollectedEvidence,
  options: { fileExtensions?: string[] } = {},
): ArktsLightScanIndex {
  const fileExtensions = new Set(
    (options.fileExtensions ?? [".ets"]).map((item) => item.toLowerCase()),
  );
  const files = evidence.workspaceFiles
    .filter((file) => fileExtensions.has(path.extname(file.relativePath).toLowerCase()))
    .map(scanFile);

  return {
    files,
    classNames: new Set(files.flatMap((file) => file.classes.map((item) => item.name))),
    interfaceNames: new Set(files.flatMap((file) => file.interfaces.map((item) => item.name))),
    typeLikeNames: new Set(
      files.flatMap((file) => [
        ...file.classes.map((item) => item.name),
        ...file.interfaces.map((item) => item.name),
        ...file.typeAliases.map((item) => item.name),
        ...file.enums.map((item) => item.name),
        ...file.namespaces.map((item) => item.name),
      ]),
    ),
    namespaceNames: new Set(files.flatMap((file) => file.namespaces.map((item) => item.name))),
    valueNames: new Set(
      files.flatMap((file) =>
        file.namedDeclarations
          .filter((item) =>
            ["function", "method", "variable", "classProperty", "enumMember"].includes(item.kind),
          )
          .map((item) => item.name),
      ),
    ),
  };
}

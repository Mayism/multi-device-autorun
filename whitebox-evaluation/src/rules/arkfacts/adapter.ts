import type {
  ArkAttributeFact,
  ArkComponentFact,
  ArkDeclarationFact,
  ArkExpressionFact,
  ArkFactsIndex,
  ArkFactDiagnostic,
  ArkMethodFact,
  ArkSourceFileFact,
  ArkViewTreeFact,
} from "./types.js";

interface SceneLike {
  projectDirectory?: unknown;
  files?: unknown;
  viewTrees?: unknown;
}

interface RawFile {
  name?: unknown;
  path?: unknown;
  classes?: unknown;
}

interface RawClass {
  name?: unknown;
  signature?: unknown;
  hasViewTree?: unknown;
  methods?: unknown;
}

interface RawViewTree {
  component?: unknown;
  signature?: unknown;
  file?: unknown;
  nodeCount?: unknown;
  root?: unknown;
}

interface RawComponentNode {
  name?: unknown;
  kind?: unknown;
  attributes?: unknown;
  stateValues?: unknown;
  children?: unknown;
  builderParam?: unknown;
}

interface RawAttribute {
  uses?: unknown;
  stmt?: unknown;
}

export function adaptArkAnalyzerScene(scene: unknown): ArkFactsIndex {
  const diagnostics: ArkFactDiagnostic[] = [];
  const sceneObject = isRecord(scene) ? (scene as SceneLike) : {};
  if (!isRecord(scene)) {
    diagnostics.push({
      code: "INVALID_SCENE",
      message: "ArkAnalyzer scene summary must be an object.",
      severity: "error",
    });
  }

  const filesInput = sceneObject.files;
  const viewTreesInput = sceneObject.viewTrees;
  const rawFiles = Array.isArray(filesInput) ? (filesInput as RawFile[]) : [];
  const rawViewTrees = Array.isArray(viewTreesInput) ? (viewTreesInput as RawViewTree[]) : [];
  if (!Array.isArray(filesInput)) {
    diagnostics.push({
      code: "INVALID_FILES",
      message: "ArkAnalyzer scene summary files must be an array.",
      severity: "error",
    });
  }
  if (!Array.isArray(viewTreesInput)) {
    diagnostics.push({
      code: "INVALID_VIEW_TREES",
      message: "ArkAnalyzer scene summary viewTrees must be an array.",
      severity: "error",
    });
  }

  const projectDirectory =
    typeof sceneObject.projectDirectory === "string" ? sceneObject.projectDirectory : undefined;
  const viewTreeFiles = new Set(
    rawViewTrees.map((tree) => normalizePath(asString(tree.file) ?? "")).filter(Boolean),
  );
  const files = buildFileFacts(rawFiles, projectDirectory, viewTreeFiles);
  const declarations = buildDeclarationFacts(rawFiles, projectDirectory);
  const methods = buildMethodFacts(rawFiles, projectDirectory);
  const { viewTrees, components } = buildViewTreeFacts(rawViewTrees);

  return {
    files,
    declarations,
    methods,
    viewTrees,
    components,
    diagnostics,
  };
}

function buildFileFacts(
  rawFiles: RawFile[],
  projectDirectory: string | undefined,
  viewTreeFiles: Set<string>,
): ArkSourceFileFact[] {
  return rawFiles.flatMap((file) => {
    const relativePath = readRelativeFilePath(file, projectDirectory);
    if (!relativePath) {
      return [];
    }
    return [
      {
        relativePath,
        hasViewTree: viewTreeFiles.has(relativePath),
      },
    ];
  });
}

function buildDeclarationFacts(
  rawFiles: RawFile[],
  projectDirectory: string | undefined,
): ArkDeclarationFact[] {
  return rawFiles.flatMap((file) => {
    const filePath = readRelativeFilePath(file, projectDirectory);
    if (!filePath || !Array.isArray(file.classes)) {
      return [];
    }
    return (file.classes as RawClass[])
      .filter((item) => asString(item.name) !== "%dflt")
      .map((item) => {
        const name = asString(item.name) ?? "unknown";
        return {
          id: declarationId(filePath, name),
          name,
          filePath,
          kind: item.hasViewTree === true ? "struct" : "class",
          extendsNames: [],
          implementsNames: [],
          fields: [],
        };
      });
  });
}

function buildMethodFacts(
  rawFiles: RawFile[],
  projectDirectory: string | undefined,
): ArkMethodFact[] {
  return rawFiles.flatMap((file) => {
    const filePath = readRelativeFilePath(file, projectDirectory);
    if (!filePath || !Array.isArray(file.classes)) {
      return [];
    }
    return (file.classes as RawClass[]).flatMap((item) => {
      const className = asString(item.name);
      const methods = Array.isArray(item.methods) ? item.methods : [];
      return methods
        .map((method) => asString(method))
        .filter((method): method is string => Boolean(method && method !== "%dflt"))
        .map((method) => ({
          name: method,
          filePath,
          kind: method === "build" ? "lifecycle" : "method",
          parameters: [],
          assignments: [],
        }));
    });
  });
}

function buildViewTreeFacts(rawViewTrees: RawViewTree[]): {
  viewTrees: ArkViewTreeFact[];
  components: ArkComponentFact[];
} {
  const viewTrees: ArkViewTreeFact[] = [];
  const components: ArkComponentFact[] = [];
  rawViewTrees.forEach((tree, treeIndex) => {
    const filePath = normalizePath(asString(tree.file) ?? "");
    const component = asString(tree.component) ?? "unknown";
    const viewTreeId = `view:${treeIndex}:${filePath}:${component}`;
    const root = isRecord(tree.root) ? (tree.root as RawComponentNode) : undefined;
    if (!root) {
      viewTrees.push({
        id: viewTreeId,
        component,
        filePath,
        nodeCount: asNumber(tree.nodeCount) ?? 0,
      });
      return;
    }

    appendComponentFacts({
      node: root,
      viewTreeId,
      filePath,
      components,
      depth: 0,
    });
    const treeComponents = components.filter((item) => item.viewTreeId === viewTreeId);
    viewTrees.push({
      id: viewTreeId,
      component,
      filePath,
      rootComponentId: treeComponents[0]?.id,
      nodeCount: asNumber(tree.nodeCount) ?? treeComponents.length,
    });
  });
  return { viewTrees, components };
}

function appendComponentFacts(options: {
  node: RawComponentNode;
  viewTreeId: string;
  filePath: string;
  components: ArkComponentFact[];
  parentId?: string;
  depth: number;
}): string {
  const id = `${options.viewTreeId}:node:${options.components.length}`;
  const children = Array.isArray(options.node.children)
    ? (options.node.children as RawComponentNode[]).filter(isRecord)
    : [];
  const component: ArkComponentFact = {
    id,
    viewTreeId: options.viewTreeId,
    name: asString(options.node.name) ?? "unknown",
    kind: normalizeComponentKind(options.node.kind, options.node.builderParam),
    filePath: options.filePath,
    ...(options.parentId ? { parentId: options.parentId } : {}),
    childIds: [],
    depth: options.depth,
    attributes: readAttributes(options.node.attributes),
    stateRefs: readStringArray(options.node.stateValues).map(normalizeSymbolName),
  };
  options.components.push(component);
  for (const child of children) {
    component.childIds.push(appendComponentFacts({
      ...options,
      node: child,
      parentId: id,
      depth: options.depth + 1,
    }));
  }
  return id;
}

function readAttributes(value: unknown): ArkAttributeFact[] {
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value)
    .filter(([name]) => name !== "pop")
    .map(([name, attribute]) => {
      const rawAttribute = isRecord(attribute) ? (attribute as RawAttribute) : {};
      const uses = readStringArray(rawAttribute.uses);
      const expr = expressionFromUses(uses);
      const opaqueReason = readOpaqueReason(expr);
      return {
        name,
        expr,
        source: name === "create" ? "create" : "modifier",
        ...(typeof rawAttribute.stmt === "string" ? { stmt: rawAttribute.stmt.slice(0, 300) } : {}),
        ...(opaqueReason ? { opaqueReason } : {}),
      };
    });
}

function expressionFromUses(uses: string[]): ArkExpressionFact {
  if (uses.length === 0) {
    return { kind: "opaque", reason: "empty_uses" };
  }
  if (uses.length > 1) {
    return {
      kind: "opaque",
      reason: "multiple attribute uses",
      raw: uses.join(", "),
    };
  }
  return expressionFromUse(uses[0] ?? "");
}

function readOpaqueReason(
  expression: ArkExpressionFact,
): ArkAttributeFact["opaqueReason"] | undefined {
  if (expression.kind !== "opaque") {
    return undefined;
  }
  if (expression.reason === "empty_uses") {
    return "empty_uses";
  }
  if (expression.reason === "multiple attribute uses") {
    return "multiple_uses";
  }
  return "unsupported_ir";
}

function expressionFromUse(useText: string): ArkExpressionFact {
  const text = useText.trim();
  if (text.startsWith("[") && text.endsWith("]")) {
    return {
      kind: "array",
      items: splitTopLevelValues(text.slice(1, -1)).map(expressionFromUse),
    };
  }
  const stringMatch = /^'([^']*)'$/.exec(text) ?? /^"([^"]*)"$/.exec(text);
  if (stringMatch) {
    const value = stringMatch[1] ?? "";
    const numeric = /^-?\d+(?:\.\d+)?$/.exec(value);
    const unitMatch = /^(-?\d+(?:\.\d+)?)(vp|px|%)$/.exec(value);
    if (unitMatch) {
      return { kind: "literal", value: Number(unitMatch[1]), unit: unitMatch[2] };
    }
    if (numeric) {
      return { kind: "literal", value: Number(value) };
    }
    if (value.startsWith("app.")) {
      return { kind: "resource", name: value };
    }
    return { kind: "literal", value };
  }
  if (text === "true" || text === "false") {
    return { kind: "literal", value: text === "true" };
  }
  if (/^-?\d+(?:\.\d+)?$/.test(text)) {
    return { kind: "literal", value: Number(text) };
  }
  const enumMatch = /^([A-Za-z_$][\w$]*)\.<@[^>]+: \.([A-Za-z_$][\w$]*)>$/.exec(text);
  if (enumMatch) {
    return { kind: "enum", name: `${enumMatch[1]}.${enumMatch[2]}` };
  }
  if (text.startsWith("this.<")) {
    return { kind: "symbol", name: normalizeSymbolName(text) };
  }
  return { kind: "symbol", name: normalizeSymbolName(text) };
}

function splitTopLevelValues(content: string): string[] {
  const values: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < content.length; index += 1) {
    const current = content[index] ?? "";
    const next = content[index + 1] ?? "";
    if (quote) {
      if (current === "\\" && next) {
        index += 1;
        continue;
      }
      if (current === quote) {
        quote = undefined;
      }
      continue;
    }
    if (current === "'" || current === "\"") {
      quote = current;
      continue;
    }
    if (current === "[" || current === "{" || current === "(") {
      depth += 1;
      continue;
    }
    if (current === "]" || current === "}" || current === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (current === "," && depth === 0) {
      const value = content.slice(start, index).trim();
      if (value) {
        values.push(value);
      }
      start = index + 1;
    }
  }
  const tail = content.slice(start).trim();
  if (tail) {
    values.push(tail);
  }
  return values;
}

function normalizeComponentKind(kind: unknown, builderParam: unknown): ArkComponentFact["kind"] {
  if (typeof builderParam === "string") {
    return "builderParam";
  }
  if (kind === "system" || kind === "custom") {
    return kind;
  }
  return "unknown";
}

function normalizeSymbolName(value: string): string {
  const memberMatch = /: ([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)>/.exec(value);
  if (memberMatch) {
    return `${memberMatch[1]}.${memberMatch[2]}`;
  }
  return value.replace(/^this\./, "");
}

function readRelativeFilePath(file: RawFile, projectDirectory: string | undefined): string {
  const name = asString(file.name);
  if (name) {
    return normalizePath(name);
  }
  const fullPath = asString(file.path);
  if (!fullPath) {
    return "";
  }
  if (projectDirectory && fullPath.startsWith(`${projectDirectory}/`)) {
    return normalizePath(fullPath.slice(projectDirectory.length + 1));
  }
  return normalizePath(fullPath);
}

function declarationId(filePath: string, name: string): string {
  return `${filePath}:${name}`;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

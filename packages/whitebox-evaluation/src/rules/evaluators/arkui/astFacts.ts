import type { ArkExpressionFact, ArkFactsIndex } from "../../arkfacts/index.js";
import type { ArkuiComponentInstance, ArkuiStaticScanIndex } from "./staticScanner.js";

const OPAQUE_CONSTRUCTOR_PROPERTIES_BY_COMPONENT: Record<string, string[]> = {
  GridRow: ["breakpoints", "columns"],
  GridCol: ["span", "offset"],
  SideBarContainer: ["type"],
  FolderStack: ["upperItems"],
};

const CREATE_ARGUMENT_PROPERTY_BY_COMPONENT: Record<string, string> = {
  SideBarContainer: "type",
  FolderStack: "upperItems",
};

export function buildArkuiStaticScanIndexFromArkFacts(facts: ArkFactsIndex): ArkuiStaticScanIndex {
  const componentById = new Map(facts.components.map((component) => [component.id, component]));
  const componentInstances = facts.components.map((component, index): ArkuiComponentInstance => {
    const constructorProperties = expandOpaqueConstructorProperties(component.name, component.attributes);
    const chainedProperties = component.attributes.filter(
      (attribute) => attribute.source !== "constructor" && attribute.source !== "create",
    );
    const parent = component.parentId ? componentById.get(component.parentId) : undefined;
    return {
      componentId: component.id,
      component: component.name,
      filePath: component.filePath,
      line: component.line ?? 1,
      startIndex: index,
      endIndex: index,
      argumentText: renderConstructorArgument(constructorProperties),
      parentId: component.parentId,
      parentComponent: parent?.name,
      childIds: component.childIds ?? [],
      childComponents: (component.childIds ?? []).flatMap((childId) => {
        const child = componentById.get(childId);
        return child ? [child.name] : [];
      }),
      source: "arkFacts",
      properties: chainedProperties.map((attribute) => ({
        name: attribute.name,
        argumentText: renderAttributeExpression(attribute),
        line: attribute.line ?? component.line ?? 1,
        usesBreakpoint: expressionUsesBreakpoint(attribute.expr) || component.stateRefs.length > 0,
      })),
    };
  });

  const componentCountByFile = new Map<string, number>();
  for (const instance of componentInstances) {
    componentCountByFile.set(
      instance.filePath,
      (componentCountByFile.get(instance.filePath) ?? 0) + 1,
    );
  }

  return {
    componentInstances,
    constants: {},
    files: [...componentCountByFile].map(([relativePath, componentCount]) => ({
      relativePath,
      componentCount,
    })),
  };
}

function expandOpaqueConstructorProperties(
  componentName: string,
  attributes: Array<{ name: string; source: string; expr?: ArkExpressionFact; line?: number }>,
): Array<{ name: string; expr?: ArkExpressionFact; line?: number }> {
  const constructorProperties = attributes.filter((attribute) => attribute.source === "constructor");
  const createAttribute = attributes.find((attribute) => attribute.source === "create");
  const createArgumentProperty = CREATE_ARGUMENT_PROPERTY_BY_COMPONENT[componentName];
  if (createArgumentProperty && createAttribute?.expr && createAttribute.expr.kind !== "opaque") {
    constructorProperties.push({
      name: createArgumentProperty,
      source: "constructor",
      line: createAttribute.line,
      expr: createAttribute.expr,
    });
  }
  const isOpaqueCreate = createAttribute?.expr?.kind === "opaque";
  if (!isOpaqueCreate) {
    return constructorProperties;
  }
  const existingNames = new Set(constructorProperties.map((attribute) => attribute.name));
  const opaqueProperties = (OPAQUE_CONSTRUCTOR_PROPERTIES_BY_COMPONENT[componentName] ?? [])
    .filter((name) => !existingNames.has(name))
    .map((name) => ({
      name,
      source: "constructor",
      line: createAttribute.line,
      expr: {
        kind: "opaque",
        reason: `unresolved ${componentName}.create argument`,
        raw: name,
      } satisfies ArkExpressionFact,
    }));
  return [...constructorProperties, ...opaqueProperties];
}

function renderConstructorArgument(
  attributes: Array<{ name: string; expr?: ArkExpressionFact }>,
): string {
  if (attributes.length === 0) {
    return "";
  }
  return `{ ${attributes.map((attribute) => `${attribute.name}: ${renderAttributeExpression(attribute)}`).join(", ")} }`;
}

function renderAttributeExpression(attribute: { name: string; expr?: ArkExpressionFact }): string {
  if (attribute.expr?.kind === "opaque") {
    return `__arkAnalyzerOpaque(${attribute.name})`;
  }
  return attribute.expr ? renderExpression(attribute.expr) : `__arkAnalyzerOpaque(${attribute.name})`;
}

function renderExpression(expression: ArkExpressionFact | undefined): string {
  if (!expression) {
    return "";
  }
  if (expression.kind === "literal") {
    if (typeof expression.value === "string") {
      return expression.unit ? `${expression.value}${expression.unit}` : JSON.stringify(expression.value);
    }
    return `${expression.value}${expression.unit ?? ""}`;
  }
  if (expression.kind === "enum") {
    return expression.name;
  }
  if (expression.kind === "resource") {
    return `$r('${expression.name}')`;
  }
  if (expression.kind === "symbol") {
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
  if (expression.kind === "opaque") {
    return expression.raw ?? "";
  }
  return expression.raw ?? "";
}

function expressionUsesBreakpoint(expression: ArkExpressionFact | undefined): boolean {
  if (!expression) {
    return false;
  }
  if (expression.kind === "breakpointValue") {
    return true;
  }
  if (expression.kind === "symbol") {
    return /breakpoint|isLargeScreen|isMediumScreen|isSmallScreen/i.test(expression.name);
  }
  if (expression.kind === "object") {
    return Object.keys(expression.properties).some((key) => ["sm", "md", "lg", "xl"].includes(key));
  }
  return false;
}

import type { RegisteredRule } from "../../types/ruleTypes.js";
import type { CollectedEvidence } from "../../evidence/types.js";
import {
  scanArktsLightFacts,
  type ArktsEnumFact,
  type ArktsLightScanIndex,
  type ArktsNamedDeclarationFact,
} from "./lightScanner.js";
import { buildArktsLightScanIndexFromArkFacts } from "./astFacts.js";
import type { EvaluatedRule } from "../shared.js";

const scanCache = new WeakMap<CollectedEvidence, ArktsLightScanIndex>();

function readFileExtensions(rule: RegisteredRule): string[] {
  const value = rule.detector.config.fileExtensions;
  if (!Array.isArray(value)) {
    return [".ets"];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function getScanIndex(rule: RegisteredRule, evidence: CollectedEvidence): ArktsLightScanIndex {
  const cached = scanCache.get(evidence);
  if (cached) {
    return cached;
  }
  const index =
    evidence.arkFacts && evidence.arkFacts.declarations.length > 0
      ? buildArktsLightScanIndexFromArkFacts(evidence.arkFacts, {
          includedFilePaths: new Set(evidence.workspaceFiles.map((file) => file.relativePath)),
        })
      : scanArktsLightFacts(evidence, { fileExtensions: readFileExtensions(rule) });
  scanCache.set(evidence, index);
  return index;
}

function buildViolationResult(
  rule: RegisteredRule,
  matches: Array<{ relativePath: string; line: number; text: string }>,
): EvaluatedRule {
  const matchedLocations = matches.map((match) => `${match.relativePath}:${match.line}`);
  return {
    rule_id: rule.rule_id,
    rule_source: rule.rule_source,
    result: matches.length > 0 ? "不满足" : "满足",
    conclusion:
      matches.length > 0
        ? `${rule.summary} 检测到规则命中，位置：${matchedLocations.join(", ")}`
        : "未发现该规则的命中证据。",
    matchedFiles: Array.from(new Set(matches.map((match) => match.relativePath))),
    matchedLocations,
    matchedSnippets: matches.map((match) => `${match.relativePath}:${match.line}: ${match.text}`),
  };
}

function runClassPropertyAccessModifierRule(
  rule: RegisteredRule,
  index: ArktsLightScanIndex,
): EvaluatedRule {
  const matches = index.files.flatMap((file) =>
    file.classProperties
      .filter((property) => !property.hasAccessModifier)
      .map((property) => ({
        relativePath: property.relativePath,
        line: property.line,
        text: property.text,
      })),
  );
  return buildViolationResult(rule, matches);
}

function runObjectLiteralClassInitializationRule(
  rule: RegisteredRule,
  index: ArktsLightScanIndex,
): EvaluatedRule {
  const matches = index.files.flatMap((file) =>
    file.objectLiteralClassInitializations
      .filter((item) => index.classNames.has(item.className))
      .map((item) => ({
        relativePath: item.relativePath,
        line: item.line,
        text: item.text,
      })),
  );
  return buildViolationResult(rule, matches);
}

function runLetNeverReassignedRule(
  rule: RegisteredRule,
  index: ArktsLightScanIndex,
): EvaluatedRule {
  const matches = index.files.flatMap((file) =>
    file.variableDeclarations
      .filter((declaration) => declaration.kind === "let")
      .filter((declaration) => !/[,[\]{}]/.test(declaration.name))
      .filter(
        (declaration) =>
          !file.assignments.some(
            (assignment) =>
              assignment.name === declaration.name && assignment.line > declaration.line,
          ),
      )
      .map((declaration) => ({
        relativePath: declaration.relativePath,
        line: declaration.line,
        text: declaration.text,
      })),
  );
  return buildViolationResult(rule, matches);
}

function allNamedDeclarations(index: ArktsLightScanIndex): ArktsNamedDeclarationFact[] {
  return index.files.flatMap((file) => file.namedDeclarations);
}

function runIdentifierNameConflictRule(
  rule: RegisteredRule,
  index: ArktsLightScanIndex,
): EvaluatedRule {
  const typeLikeDeclarations = allNamedDeclarations(index).filter((declaration) =>
    ["class", "interface", "type", "enum", "namespace"].includes(declaration.kind),
  );
  const typeLikeNameCounts = new Map<string, number>();
  for (const declaration of typeLikeDeclarations) {
    typeLikeNameCounts.set(declaration.name, (typeLikeNameCounts.get(declaration.name) ?? 0) + 1);
  }

  const matches = typeLikeDeclarations
    .filter(
      (declaration) =>
        index.valueNames.has(declaration.name) ||
        (typeLikeNameCounts.get(declaration.name) ?? 0) > 1,
    )
    .map((declaration) => ({
      relativePath: declaration.relativePath,
      line: declaration.line,
      text: declaration.text,
    }));
  return buildViolationResult(rule, matches);
}

function runClassInterfaceHeritageRule(
  rule: RegisteredRule,
  index: ArktsLightScanIndex,
): EvaluatedRule {
  const matches = index.files.flatMap((file) =>
    file.heritage
      .filter((item) => {
        if (item.kind === "class") {
          return (
            item.implementsNames.some((name) => index.classNames.has(name)) ||
            item.extendsNames.some((name) => index.interfaceNames.has(name))
          );
        }
        return item.extendsNames.some((name) => index.classNames.has(name));
      })
      .map((item) => ({
        relativePath: item.relativePath,
        line: item.line,
        text: item.text,
      })),
  );
  return buildViolationResult(rule, matches);
}

function runEsObjectUsageScopeRule(
  rule: RegisteredRule,
  index: ArktsLightScanIndex,
): EvaluatedRule {
  const matches = allNamedDeclarations(index)
    .filter(
      (declaration) => declaration.typeName === "ESObject" || /\bESObject\b/.test(declaration.text),
    )
    .map((declaration) => ({
      relativePath: declaration.relativePath,
      line: declaration.line,
      text: declaration.text,
    }));
  return buildViolationResult(rule, matches);
}

function runClassAsValueRule(rule: RegisteredRule, index: ArktsLightScanIndex): EvaluatedRule {
  const matches = allNamedDeclarations(index)
    .filter((declaration) => declaration.kind === "variable" && declaration.initializer)
    .filter((declaration) => {
      const initializer = declaration.initializer?.replace(/;$/, "").trim() ?? "";
      return index.classNames.has(initializer);
    })
    .map((declaration) => ({
      relativePath: declaration.relativePath,
      line: declaration.line,
      text: declaration.text,
    }));
  return buildViolationResult(rule, matches);
}

function isUpperCamelCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

function isLowerCamelCase(name: string): boolean {
  return /^[a-z][A-Za-z0-9]*$/.test(name);
}

function isUpperSnakeCase(name: string): boolean {
  return /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(name);
}

function runTypeNameUpperCamelRule(
  rule: RegisteredRule,
  index: ArktsLightScanIndex,
): EvaluatedRule {
  const matches = allNamedDeclarations(index)
    .filter((declaration) => ["class", "interface", "enum", "namespace"].includes(declaration.kind))
    .filter((declaration) => !isUpperCamelCase(declaration.name))
    .map((declaration) => ({
      relativePath: declaration.relativePath,
      line: declaration.line,
      text: declaration.text,
    }));
  return buildViolationResult(rule, matches);
}

function runValueNameLowerCamelRule(
  rule: RegisteredRule,
  index: ArktsLightScanIndex,
): EvaluatedRule {
  const matches = allNamedDeclarations(index)
    .filter((declaration) =>
      ["variable", "function", "method", "parameter"].includes(declaration.kind),
    )
    .filter((declaration) => !isLowerCamelCase(declaration.name))
    .map((declaration) => ({
      relativePath: declaration.relativePath,
      line: declaration.line,
      text: declaration.text,
    }));
  return buildViolationResult(rule, matches);
}

function runConstantEnumUpperSnakeRule(
  rule: RegisteredRule,
  index: ArktsLightScanIndex,
): EvaluatedRule {
  const enumMemberMatches = allNamedDeclarations(index)
    .filter((declaration) => declaration.kind === "enumMember")
    .filter((declaration) => !isUpperSnakeCase(declaration.name));
  const topLevelConstMatches = index.files
    .flatMap((file) => file.variableDeclarations)
    .filter((declaration) => declaration.kind === "const" && declaration.scope === "topLevel")
    .filter((declaration) => !isUpperSnakeCase(declaration.name));
  const matches = [...enumMemberMatches, ...topLevelConstMatches].map((declaration) => ({
    relativePath: declaration.relativePath,
    line: declaration.line,
    text: declaration.text,
  }));
  return buildViolationResult(rule, matches);
}

function isBooleanName(name: string): boolean {
  return /^(?:is|has|can|should)[A-Z]/.test(name);
}

function isNegativeBooleanName(name: string): boolean {
  return /^(?:not|no|non|disable|disabled|invalid)[A-Z_]/i.test(name);
}

function runBooleanNamePrefixRule(rule: RegisteredRule, index: ArktsLightScanIndex): EvaluatedRule {
  const matches = allNamedDeclarations(index)
    .filter((declaration) => declaration.typeName === "boolean")
    .filter(
      (declaration) => !isBooleanName(declaration.name) || isNegativeBooleanName(declaration.name),
    )
    .map((declaration) => ({
      relativePath: declaration.relativePath,
      line: declaration.line,
      text: declaration.text,
    }));
  return buildViolationResult(rule, matches);
}

function runSpacingStyleRule(rule: RegisteredRule, index: ArktsLightScanIndex): EvaluatedRule {
  const matches = index.files.flatMap((file) => file.spacingIssues);
  return buildViolationResult(rule, matches);
}

function classifyEnumInitializer(
  initializer: string | undefined,
): "none" | "number" | "string" | "runtime" {
  if (!initializer) {
    return "none";
  }
  if (/^-?\d+(?:\.\d+)?$/.test(initializer)) {
    return "number";
  }
  if (/^["'][^"']*["']$/.test(initializer)) {
    return "string";
  }
  return "runtime";
}

function hasEnumRestrictionViolation(item: ArktsEnumFact, namespaceNames: Set<string>): boolean {
  const initializerKinds = new Set(
    item.memberInitializers
      .map((member) => classifyEnumInitializer(member.initializer))
      .filter((kind) => kind !== "none"),
  );
  return (
    initializerKinds.has("runtime") ||
    (initializerKinds.has("number") && initializerKinds.has("string")) ||
    namespaceNames.has(item.name)
  );
}

function runEnumNamespaceRestrictionRule(
  rule: RegisteredRule,
  index: ArktsLightScanIndex,
): EvaluatedRule {
  const matches = index.files.flatMap((file) =>
    file.enums
      .filter((item) => hasEnumRestrictionViolation(item, index.namespaceNames))
      .map((item) => ({
        relativePath: item.relativePath,
        line: item.line,
        text: item.text,
      })),
  );
  return buildViolationResult(rule, matches);
}

export function runArktsStaticRule(
  rule: RegisteredRule,
  evidence: CollectedEvidence,
): EvaluatedRule {
  const check = rule.detector.config.check;
  const index = getScanIndex(rule, evidence);

  if (check === "identifier_name_conflict") {
    return runIdentifierNameConflictRule(rule, index);
  }
  if (check === "class_interface_heritage") {
    return runClassInterfaceHeritageRule(rule, index);
  }
  if (check === "esobject_usage_scope") {
    return runEsObjectUsageScopeRule(rule, index);
  }
  if (check === "class_as_value") {
    return runClassAsValueRule(rule, index);
  }
  if (check === "type_name_upper_camel") {
    return runTypeNameUpperCamelRule(rule, index);
  }
  if (check === "value_name_lower_camel") {
    return runValueNameLowerCamelRule(rule, index);
  }
  if (check === "constant_enum_upper_snake") {
    return runConstantEnumUpperSnakeRule(rule, index);
  }
  if (check === "boolean_name_prefix") {
    return runBooleanNamePrefixRule(rule, index);
  }
  if (check === "spacing_style") {
    return runSpacingStyleRule(rule, index);
  }
  if (check === "enum_namespace_restrictions") {
    return runEnumNamespaceRestrictionRule(rule, index);
  }
  if (check === "class_property_access_modifier") {
    return runClassPropertyAccessModifierRule(rule, index);
  }
  if (check === "object_literal_class_initialization") {
    return runObjectLiteralClassInitializationRule(rule, index);
  }
  if (check === "let_never_reassigned") {
    return runLetNeverReassignedRule(rule, index);
  }

  return {
    rule_id: rule.rule_id,
    rule_source: rule.rule_source,
    result: "未接入判定器",
    conclusion: `${rule.summary} 当前版本未接入静态判定器，需要 Agent 辅助判定。`,
    matchedFiles: [],
  };
}

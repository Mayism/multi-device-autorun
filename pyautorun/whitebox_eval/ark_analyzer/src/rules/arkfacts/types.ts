export type ArkFactSeverity = "warning" | "error";

export interface ArkFactDiagnostic {
  code: string;
  message: string;
  severity: ArkFactSeverity;
  filePath?: string;
}

export interface ArkFactsIndex {
  files: ArkSourceFileFact[];
  declarations: ArkDeclarationFact[];
  methods: ArkMethodFact[];
  viewTrees: ArkViewTreeFact[];
  components: ArkComponentFact[];
  diagnostics: ArkFactDiagnostic[];
}

export interface ArkSourceFileFact {
  relativePath: string;
  hasViewTree: boolean;
}

export interface ArkDeclarationFact {
  id: string;
  name: string;
  filePath: string;
  kind: "class" | "struct" | "interface" | "enum" | "namespace" | "unknown";
  line?: number;
  extendsNames: string[];
  implementsNames: string[];
  fields: ArkFieldFact[];
  enumMembers?: ArkEnumMemberFact[];
}

export interface ArkMethodFact {
  name: string;
  filePath: string;
  kind: "method" | "function" | "builder" | "lifecycle" | "unknown";
  line?: number;
  parameters: ArkParameterFact[];
  assignments: ArkAssignmentFact[];
}

export interface ArkFieldFact {
  name: string;
  line?: number;
  typeText?: string;
  initializer?: ArkExpressionFact;
  accessModifier?: "public" | "private" | "protected";
}

export interface ArkEnumMemberFact {
  name: string;
  line?: number;
  initializer?: ArkExpressionFact;
}

export interface ArkParameterFact {
  name: string;
  typeText?: string;
  optional: boolean;
}

export interface ArkAssignmentFact {
  target: string;
  line?: number;
  value?: ArkExpressionFact;
}

export interface ArkViewTreeFact {
  id: string;
  component: string;
  filePath: string;
  rootComponentId?: string;
  nodeCount: number;
}

export interface ArkComponentFact {
  id: string;
  viewTreeId: string;
  name: string;
  kind: "system" | "custom" | "builderParam" | "unknown";
  filePath: string;
  parentId?: string;
  childIds: string[];
  depth?: number;
  attributes: ArkAttributeFact[];
  stateRefs: string[];
  line?: number;
}

export interface ArkAttributeFact {
  name: string;
  expr?: ArkExpressionFact;
  line?: number;
  stmt?: string;
  source: "constructor" | "modifier" | "create" | "synthetic" | "unknown";
  opaqueReason?: "empty_uses" | "multiple_uses" | "unresolved_temp" | "unsupported_ir";
}

export type BreakpointKey = "sm" | "md" | "lg" | "xl";

export type ArkExpressionFact =
  | { kind: "literal"; value: string | number | boolean | null; unit?: string }
  | { kind: "enum"; name: string }
  | { kind: "resource"; name: string }
  | { kind: "object"; properties: Record<string, ArkExpressionFact> }
  | { kind: "array"; items: ArkExpressionFact[] }
  | { kind: "symbol"; name: string; resolved?: ArkExpressionFact }
  | { kind: "call"; callee: string; args: ArkExpressionFact[] }
  | { kind: "breakpointValue"; values: Partial<Record<BreakpointKey, ArkExpressionFact>> }
  | { kind: "opaque"; reason: string; raw?: string }
  | { kind: "unknown"; reason: string; raw?: string };

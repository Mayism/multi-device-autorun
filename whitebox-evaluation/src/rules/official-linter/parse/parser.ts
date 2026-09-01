import type { OfficialLinterFinding } from "../../../types.js";

export type OfficialCodeLinterParseStatus = "parsed" | "unparsed";

export interface OfficialCodeLinterParseResult {
  status: OfficialCodeLinterParseStatus;
  findings: OfficialLinterFinding[];
}

function severityFrom(value: unknown): OfficialLinterFinding["severity"] {
  if (value === 2 || value === "2" || String(value).toLowerCase() === "error") {
    return "error";
  }
  if (value === 1 || value === "1" || String(value).toLowerCase() === "warn") {
    return "warn";
  }
  if (value === 0 || value === "0" || String(value).toLowerCase() === "suggestion") {
    return "suggestion";
  }
  return "unknown";
}

function sourceRuleSetFrom(ruleId: string): string {
  if (ruleId.startsWith("@security/")) {
    return "plugin:@security/recommended";
  }
  if (ruleId.startsWith("@performance/")) {
    return "plugin:@performance/recommended";
  }
  if (ruleId.startsWith("@hw-stylistic/")) {
    return "plugin:@hw-stylistic/recommended";
  }
  if (ruleId.startsWith("@typescript-eslint/")) {
    return "plugin:@typescript-eslint/recommended";
  }
  if (ruleId.startsWith("@cross-device-app-dev/")) {
    return "plugin:@cross-device-app-dev/recommended";
  }
  return "unknown";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function toNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseJson(text: string): OfficialLinterFinding[] | undefined {
  try {
    const parsed = JSON.parse(text);
    const records = Array.isArray(parsed)
      ? parsed
      : Array.isArray(asRecord(parsed).results)
        ? (asRecord(parsed).results as unknown[])
        : undefined;
    if (!records) {
      return undefined;
    }

    const findings: OfficialLinterFinding[] = [];
    for (const record of records) {
      const result = asRecord(record);
      const file = String(result.filePath ?? result.file ?? "");
      const messages = Array.isArray(result.messages) ? result.messages : [];
      for (const messageValue of messages) {
        const message = asRecord(messageValue);
        const ruleId = String(message.ruleId ?? message.rule_id ?? message.rule ?? "");
        if (!file || !ruleId) {
          continue;
        }
        findings.push({
          rule_id: ruleId,
          message: String(message.message ?? ""),
          severity: severityFrom(message.severity),
          file,
          line: toNumber(message.line),
          column: toNumber(message.column),
          source_rule_set: sourceRuleSetFrom(ruleId),
        });
      }
    }
    return findings;
  } catch {
    return undefined;
  }
}

function stripAnsi(text: string): string {
  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 27 && text[index + 1] === "[") {
      index += 2;
      while (index < text.length && text[index] !== "m") {
        index += 1;
      }
      continue;
    }
    output += text[index] ?? "";
  }
  return output;
}

function parseJsonFromOutput(text: string): OfficialLinterFinding[] | undefined {
  const direct = parseJson(text);
  if (direct) {
    return direct;
  }

  for (const line of stripAnsi(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
      continue;
    }
    const parsed = parseJson(trimmed);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

function parseText(text: string): OfficialLinterFinding[] {
  const findings: OfficialLinterFinding[] = [];
  const linePattern =
    /^(.+?):(\d+):(\d+)\s+(error|warn|warning|suggestion)\s+(.+?)\s+(@[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)\s*$/;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(linePattern);
    if (!match) {
      continue;
    }
    const ruleId = match[6] ?? "";
    findings.push({
      file: match[1] ?? "",
      line: Number(match[2]),
      column: Number(match[3]),
      severity: severityFrom(match[4] === "warning" ? "warn" : match[4]),
      message: match[5] ?? "",
      rule_id: ruleId,
      source_rule_set: sourceRuleSetFrom(ruleId),
    });
  }
  return findings;
}

export function parseOfficialCodeLinterOutput(input: {
  stdout: string;
  stderr: string;
}): OfficialCodeLinterParseResult {
  const stdout = input.stdout.trim();
  const jsonFindings = stdout ? parseJsonFromOutput(stdout) : undefined;
  if (jsonFindings) {
    return { status: "parsed", findings: jsonFindings };
  }

  const textFindings = parseText(`${input.stdout}\n${input.stderr}`);
  if (textFindings.length > 0) {
    return { status: "parsed", findings: textFindings };
  }

  return { status: "unparsed", findings: [] };
}

import type { OfficialLinterRunStatus } from "../../../types.js";

export function sanitizeOfficialCodeLinterOutput(input: {
  text: string;
  effectiveFindingCount: number;
  runStatus: OfficialLinterRunStatus;
}): string {
  const commandLevelLines = input.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/:\d+:\d+\s+(error|warn|warning|suggestion)\s+/i.test(line))
    .filter((line) => !/@[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+/.test(line))
    .filter((line) => !/\.(ets|ts|js|json5?)\b/i.test(line));

  return [
    `runStatus=${input.runStatus}`,
    `effectiveFindingCount=${input.effectiveFindingCount}`,
    ...commandLevelLines.slice(0, 20),
  ].join("\n");
}

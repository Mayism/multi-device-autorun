import path from "node:path";

export function buildOpencodeRequestTag(input: {
  prefix: string;
  caseId: string;
  sandboxRoot: string;
}): string {
  const caseRunId = path.basename(path.dirname(path.resolve(input.sandboxRoot)));
  return `${input.prefix}-${input.caseId}-${caseRunId}`;
}

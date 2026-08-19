export class FinalJsonParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FinalJsonParseError";
  }
}

function stripFence(rawText: string): string {
  const trimmed = rawText.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

function findJsonObjectSlices(text: string): string[] {
  const slices: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char === "}") {
      if (depth === 0) {
        continue;
      }
      depth -= 1;
      if (depth === 0 && start >= 0) {
        slices.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return slices;
}

export function extractFinalJsonObject(rawText: string): Record<string, unknown> {
  const candidateText = stripFence(rawText);
  const slices = findJsonObjectSlices(candidateText);
  if (slices.length !== 1) {
    throw new FinalJsonParseError(
      `期望 opencode 最终输出包含且只包含一个 JSON object，实际数量=${slices.length}`,
    );
  }

  try {
    const parsed = JSON.parse(slices[0]!) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new FinalJsonParseError("opencode 最终 JSON 必须是 object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof FinalJsonParseError) {
      throw error;
    }
    throw new FinalJsonParseError("opencode 最终 JSON 解析失败", { cause: error });
  }
}

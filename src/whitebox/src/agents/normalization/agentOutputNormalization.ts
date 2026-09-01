import { z } from "zod";

function coerceFiniteNumber(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }

  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : value;
}

function coerceBoolean(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return value;
}

export const finiteNumberSchema = z.preprocess(
  coerceFiniteNumber,
  z.number().refine(Number.isFinite, { message: "Expected finite number" }),
);

export const booleanLikeSchema = z.preprocess(coerceBoolean, z.boolean());

export function snapScoreToAllowedBand(score: number, allowedScores: Iterable<number>): number {
  const scores = Array.from(allowedScores).filter(Number.isFinite);
  if (scores.length === 0) {
    return score;
  }

  return scores.reduce((best, candidate) => {
    const bestDistance = Math.abs(score - best);
    const candidateDistance = Math.abs(score - candidate);
    if (candidateDistance < bestDistance) {
      return candidate;
    }
    if (candidateDistance === bestDistance && candidate > best) {
      return candidate;
    }
    return best;
  }, scores[0]!);
}

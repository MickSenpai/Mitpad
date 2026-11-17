import { ConvexError } from "convex/values";

export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 32;

/** Trims, lowercases and de-duplicates tags, rejecting more than 10 or longer than 32 characters. */
export function normalizeTags(tags: readonly string[]): string[] {
  const normalized = [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  if (normalized.length > MAX_TAGS || normalized.some((tag) => tag.length > MAX_TAG_LENGTH)) {
    throw new ConvexError(`Usa hasta ${MAX_TAGS} etiquetas de ${MAX_TAG_LENGTH} caracteres cada una.`);
  }
  return normalized;
}

/**
 * The text a category is matched against semantically.
 *
 * Name and description together, because they carry different halves of the
 * answer: the name is the sector (« Merchandising & Commerce ») and the
 * description is the actual work («… tenue de caisse …»). Someone types the
 * work, not the sector.
 */
export function categoryEmbeddingText(
  name: string,
  description: string | null,
): string {
  return description ? `${name}. ${description}` : name;
}

/**
 * Cosine similarity, computed with magnitudes rather than as a bare dot
 * product.
 *
 * fastembed returns normalised vectors today, which would make the dot product
 * enough — but a model swap that returned unnormalised ones would not fail
 * here, it would quietly return scores above 1 and drag everything past the
 * threshold. Dividing by the norms costs nothing at this size.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

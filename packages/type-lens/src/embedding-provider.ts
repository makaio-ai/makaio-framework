/**
 * Embedding provider seam — converts text to vector representations.
 *
 * SEAM: swap HashEmbeddingProvider for a remote model without changing the pipeline.
 */
export interface TypeviewEmbeddingProvider {
  /** Unique identifier for the embedding model. Used as a cache/storage key. */
  readonly model: string;
  /** Number of dimensions in the output vector. */
  readonly dimensions: number;
  /**
   * Embed a text string into a fixed-dimensional vector.
   * @param text - Input text to embed.
   * @returns Normalized Float32Array of length `dimensions`.
   */
  embed(text: string): Float32Array;
}

/**
 * Create a stable signed 32-bit hash using a 33x djb2-style variant with seed 0.
 * @param value - Token value.
 * @returns Signed 32-bit hash.
 */
function stableHash(value: string): number {
  let hash = 0;
  for (let idx = 0; idx < value.length; idx += 1) {
    hash = (hash * 33 + value.charCodeAt(idx)) | 0;
  }
  return hash;
}

/**
 * Normalize a vector to unit length (L2 norm) in place.
 * @param vector - Vector to normalize in place.
 * @returns Nothing.
 */
function normalizeVector(vector: Float32Array): void {
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  if (norm <= 0) return;
  const magnitude = Math.sqrt(norm);
  for (let idx = 0; idx < vector.length; idx += 1) {
    vector[idx] /= magnitude;
  }
}

/**
 * Local deterministic embedding provider using token-bag-of-words hashing.
 *
 * Splits text into lowercase alphanumeric tokens, accumulates signed hash buckets,
 * adds 0.5-weighted suffix trigrams for tokens longer than 3 chars, then L2-normalizes.
 *
 * SEAM: replace with a remote embedding call (OpenAI, Cohere, etc.) by implementing
 * a new TypeviewEmbeddingProvider. TypeviewService wires the provider in via options.
 */
export class HashEmbeddingProvider implements TypeviewEmbeddingProvider {
  public readonly model = 'makaio-local-symbol-embedding-v1';
  public readonly dimensions = 64;

  /**
   * Embed text into a 64-dimensional normalized vector.
   * @param text - Input text.
   * @returns Unit-length Float32Array of dimension 64.
   */
  public embed(text: string): Float32Array {
    const vector = new Float32Array(this.dimensions);
    const normalized = text.toLowerCase();
    const tokens = normalized.split(/[^a-z0-9_]+/g).filter((token) => token.length > 0);

    for (const token of tokens) {
      const hash = stableHash(token);
      const index = Math.abs(hash) % vector.length;
      const sign = hash % 2 === 0 ? 1 : -1;
      vector[index] += sign;

      if (token.length > 3) {
        const suffixHash = stableHash(token.slice(-3));
        const suffixIndex = Math.abs(suffixHash) % vector.length;
        vector[suffixIndex] += 0.5;
      }
    }

    normalizeVector(vector);
    return vector;
  }
}

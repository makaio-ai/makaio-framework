/**
 * Shared vector math and blob conversion utilities for embedding storage and retrieval.
 */

/**
 * Calculate cosine similarity between two pre-normalized vectors.
 *
 * Because both inputs are assumed to be L2-normalized, this is equivalent to their dot product.
 * @param left - Query vector (unit length).
 * @param right - Candidate vector (unit length).
 * @returns Similarity score in [-1, 1].
 */
export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) {
    throw new RangeError(`Vector dimension mismatch: left=${left.length}, right=${right.length}`);
  }
  let dot = 0;
  for (let idx = 0; idx < left.length; idx += 1) {
    dot += left[idx] * right[idx];
  }
  return dot;
}

/**
 * Convert a Float32Array to a Buffer for SQLite BLOB storage.
 * @param value - In-memory embedding vector.
 * @returns Binary representation for SQLite BLOB columns.
 */
export function toEmbeddingBlob(value: Float32Array): Buffer {
  return Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
}

/**
 * Convert a BLOB-compatible binary value to a Float32Array.
 * @param value - Raw binary value (Uint8Array, ArrayBuffer, or Buffer).
 * @returns Decoded Float32Array.
 */
export function toFloat32Array(value: Uint8Array | ArrayBuffer | Buffer): Float32Array {
  if (value instanceof ArrayBuffer) {
    if (value.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
      throw new RangeError(`Invalid Float32Array byte length: ${value.byteLength}`);
    }
    return new Float32Array(value);
  }

  if (value.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new RangeError(`Invalid Float32Array byte length: ${value.byteLength}`);
  }
  if (value.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0) {
    return new Float32Array(value.buffer, value.byteOffset, value.byteLength / Float32Array.BYTES_PER_ELEMENT);
  }
  return new Float32Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

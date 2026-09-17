/**
 * Assembly of a chunk list read from a byte stream into one contiguous buffer.
 *
 * Shared by the two bounded readers in this layer — the request-body buffer and
 * the upstream error-body reader. Only the assembly step is shared: the reading
 * loops themselves differ in kind (one rejects an oversized body, the other
 * stops and records that it saw only part of one), so they stay separate.
 * @packageDocumentation
 */

/**
 * Concatenate stream chunks into a single buffer.
 *
 * `total` is passed rather than re-derived so the caller keeps the running count
 * it already maintains for its own bound, and so a caller that sliced its final
 * chunk cannot disagree with the buffer it gets back.
 * @param chunks - Chunks in arrival order. Their lengths must sum to `total`.
 * @param total - Combined byte length of `chunks`.
 * @returns One buffer holding every chunk, in order.
 */
export function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const buffered = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffered.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffered;
}

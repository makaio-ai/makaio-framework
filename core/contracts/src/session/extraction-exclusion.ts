/**
 * Extraction-exclusion metadata contract.
 *
 * Defines the canonical metadata key and helpers for marking a session as
 * excluded from downstream data-point extraction. Fork children created
 * specifically for extraction (ai-factory UC1) carry this marker so the
 * extraction pipeline does not re-extract them, preventing infinite fork
 * loops.
 *
 * The key lives in the opaque `metadata` record on the session row
 * (`Record<string, JsonValue>`). The namespace prefix `makaio:` prevents
 * collisions with consumer-defined metadata keys.
 * @packageDocumentation
 */

/**
 * Canonical metadata key that marks a session as excluded from downstream
 * extraction pipelines.
 *
 * Value is a boolean `true` when the session should be excluded. Absence
 * of the key (or `false`) means the session is eligible for extraction.
 * @example
 * ```ts
 * const metadata = { [EXTRACTION_EXCLUSION_KEY]: true };
 * ```
 */
export const EXTRACTION_EXCLUSION_KEY = 'makaio:extraction-excluded' as const;

/** The literal type of the extraction-exclusion metadata key. */
export type ExtractionExclusionKey = typeof EXTRACTION_EXCLUSION_KEY;

/**
 * Shape of the extraction-exclusion metadata entry when present.
 *
 * The key maps to boolean `true`; other values are invalid and should
 * be treated as "not excluded".
 */
export type ExtractionExclusionMetadata = {
  readonly [EXTRACTION_EXCLUSION_KEY]: true;
};

/**
 * Test whether a session metadata record carries the extraction-exclusion
 * marker.
 * @param metadata - Session metadata record, or `undefined`/`null` when
 *   the session has no metadata.
 * @returns `true` when the session is excluded from extraction
 */
export function isExtractionExcluded(metadata: Record<string, unknown> | undefined | null): boolean {
  return metadata?.[EXTRACTION_EXCLUSION_KEY] === true;
}

/**
 * Build a metadata record fragment containing the extraction-exclusion
 * marker.
 *
 * Spread the result into the session's metadata to mark it as excluded:
 * ```ts
 * const metadata = { ...existingMetadata, ...buildExtractionExclusionMetadata() };
 * ```
 * @returns Metadata fragment with the exclusion marker set to `true`
 */
export function buildExtractionExclusionMetadata(): ExtractionExclusionMetadata {
  return { [EXTRACTION_EXCLUSION_KEY]: true };
}

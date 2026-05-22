/**
 * Internal storage format for localStorage entries.
 * Wraps user value with metadata for conflict resolution.
 */
export interface StoredPreference {
  /** JSON-serialized user value */
  value: string;
  /** Unix timestamp (ms) when this value was written */
  updatedAt: number;
}
